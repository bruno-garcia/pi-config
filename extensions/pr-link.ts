/**
 * pr-link - Shows the PR URL, CI status, and unresolved comments in the pi footer.
 *
 * Detects the current git branch, looks up an associated PR via `gh`,
 * and displays the PR link with CI check results and unresolved review
 * thread count in the status bar. Re-checks periodically.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";

const POLL_INTERVAL = 30_000;
const STATUS_KEY = "pr-link";

function getBranch(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

function getRepoOwnerAndName(cwd: string): { owner: string; name: string } | undefined {
	try {
		const json = execSync("gh repo view --json owner,name", {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const repo = JSON.parse(json);
		return repo.owner?.login && repo.name ? { owner: repo.owner.login, name: repo.name } : undefined;
	} catch {
		return undefined;
	}
}

interface CheckStatus {
	total: number;
	pass: number;
	fail: number;
	pending: number;
}

interface PrInfo {
	number: number;
	title: string;
	url: string;
	state: string;
	checks: CheckStatus;
	unresolvedThreads: number;
}

function getPrForBranch(cwd: string, repo?: { owner: string; name: string }): PrInfo | undefined {
	try {
		// Get basic PR info + status checks in one call
		const json = execSync("gh pr view --json number,title,url,state,statusCheckRollup", {
			cwd,
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (!json) return undefined;
		const pr = JSON.parse(json);
		if (!pr.number || !pr.url) return undefined;

		// Parse status checks
		const checks: CheckStatus = { total: 0, pass: 0, fail: 0, pending: 0 };
		if (Array.isArray(pr.statusCheckRollup)) {
			for (const check of pr.statusCheckRollup) {
				checks.total++;
				const conclusion = (check.conclusion || "").toUpperCase();
				const status = (check.status || "").toUpperCase();
				if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
					checks.pass++;
				} else if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED" || conclusion === "ACTION_REQUIRED") {
					checks.fail++;
				} else if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || status === "WAITING" || !conclusion) {
					checks.pending++;
				}
			}
		}

		// Get unresolved review threads via GraphQL
		let unresolvedThreads = 0;
		if (repo) {
			try {
				const gql = execSync(
					`gh api graphql -f query='{ repository(owner: "${repo.owner}", name: "${repo.name}") { pullRequest(number: ${pr.number}) { reviewThreads(first: 100) { nodes { isResolved } } } } }'`,
					{
						cwd,
						encoding: "utf-8",
						timeout: 10_000,
						stdio: ["pipe", "pipe", "pipe"],
					},
				).trim();
				const data = JSON.parse(gql);
				const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
				if (Array.isArray(threads)) {
					unresolvedThreads = threads.filter((t: { isResolved: boolean }) => !t.isResolved).length;
				}
			} catch {
				// GraphQL failed — show PR without thread count
			}
		}

		return {
			number: pr.number,
			title: pr.title,
			url: pr.url,
			state: pr.state,
			checks,
			unresolvedThreads,
		};
	} catch {
		return undefined;
	}
}

function formatStatus(pr: PrInfo): string {
	const stateIcon = pr.state === "MERGED" ? "🟣" : pr.state === "CLOSED" ? "🔴" : "🟢";
	const parts: string[] = [`${stateIcon} PR #${pr.number}`];

	// CI checks summary
	if (pr.checks.total > 0) {
		if (pr.checks.fail > 0) {
			parts.push(`❌ ${pr.checks.fail}/${pr.checks.total} checks failed`);
		} else if (pr.checks.pending > 0) {
			parts.push(`⏳ ${pr.checks.pending}/${pr.checks.total} checks pending`);
		} else {
			parts.push(`✅ ${pr.checks.total} checks passed`);
		}
	}

	// Unresolved review threads
	if (pr.unresolvedThreads > 0) {
		parts.push(`💬 ${pr.unresolvedThreads} unresolved`);
	}

	parts.push(pr.url);
	return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastBranch: string | undefined;
	let lastPr: PrInfo | undefined;
	let cachedRepo: { owner: string; name: string } | undefined;
	let branchChangeDetected = false;

	function update(cwd: string, ui: { setStatus: (key: string, value: string | undefined) => void }) {
		const branch = getBranch(cwd);

		if (branch !== lastBranch) {
			lastBranch = branch;
			branchChangeDetected = true;
			lastPr = undefined;
		}

		if (!branch || branch === "HEAD") {
			lastPr = undefined;
			ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		// Cache repo info (rarely changes)
		if (!cachedRepo) {
			cachedRepo = getRepoOwnerAndName(cwd);
		}

		// Always re-fetch PR details (checks/comments change over time)
		const pr = getPrForBranch(cwd, cachedRepo);
		lastPr = pr ?? undefined;

		if (lastPr) {
			ui.setStatus(STATUS_KEY, formatStatus(lastPr));
		} else {
			ui.setStatus(STATUS_KEY, undefined);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		update(ctx.cwd, ctx.ui);
		timer = setInterval(() => update(ctx.cwd, ctx.ui), POLL_INTERVAL);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastBranch = undefined;
		lastPr = undefined;
		cachedRepo = undefined;
		update(ctx.cwd, ctx.ui);
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});
}
