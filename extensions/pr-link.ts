/**
 * pr-link - Shows the PR URL for the current branch in the pi footer.
 *
 * Detects the current git branch, looks up an associated PR via `gh pr view`,
 * and displays the PR link in the status bar. Re-checks periodically and when
 * the branch changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";

const POLL_INTERVAL = 10_000;
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

interface PrInfo {
	number: number;
	title: string;
	url: string;
	state: string;
}

function getPrForBranch(cwd: string): PrInfo | undefined {
	try {
		const json = execSync(
			'gh pr view --json number,title,url,state 2>/dev/null',
			{
				cwd,
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			},
		).trim();
		if (!json) return undefined;
		const pr = JSON.parse(json);
		if (pr.number && pr.url) return pr as PrInfo;
		return undefined;
	} catch {
		return undefined;
	}
}

function formatStatus(pr: PrInfo): string {
	const stateIcon = pr.state === "MERGED" ? "🟣" : pr.state === "CLOSED" ? "🔴" : "🟢";
	return `${stateIcon} PR #${pr.number}: ${pr.url}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastBranch: string | undefined;
	let lastPr: PrInfo | undefined;

	function update(cwd: string, ui: { setStatus: (key: string, value: string | undefined) => void }) {
		const branch = getBranch(cwd);

		// Only re-query PR if branch changed or we haven't checked yet
		if (branch !== lastBranch || lastPr === undefined) {
			lastBranch = branch;
			if (!branch || branch === "HEAD") {
				lastPr = undefined;
				ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const pr = getPrForBranch(cwd);
			lastPr = pr ?? undefined;
		}

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
		// Reset on session switch so we re-check
		lastBranch = undefined;
		lastPr = undefined;
		update(ctx.cwd, ctx.ui);
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});
}
