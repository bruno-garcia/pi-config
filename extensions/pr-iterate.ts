/**
 * PR Iterate — Automatic CI watching + review addressing after every push.
 *
 * Status bar (always on):
 *   Shows PR number, CI checks, unresolved review threads, and URL.
 *   Detects PRs from the current branch. Use /pr-iterate pin <url> for cross-branch PRs.
 *
 * Auto-iteration (toggleable, on by default):
 *   After the agent pushes code (git push / gh pr create), automatically:
 *   1. Watches CI until all checks pass (or fail → stop)
 *   2. Waits for bot reviews to land (5+ min after push, Sentry check done)
 *   3. Addresses all review comments (assess, reply, react, resolve)
 *   4. If changes are pushed → repeats (up to MAX_ITERATIONS)
 *
 * Commands:
 *   /pr-iterate          Toggle auto-iteration on/off
 *   /pr-iterate on       Enable
 *   /pr-iterate off      Disable
 *   /pr-iterate run      Trigger one iteration manually
 *   /pr-iterate reset    Reset the iteration counter
 *   /pr-iterate status   Show current state
 *   /pr-iterate pin <url> Pin a specific PR by URL
 *   /pr-iterate unpin   Unpin and use branch detection
 *
 * Replaces: pi-pr-status (npm package) — all status bar features are included.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";

// ── GitHub helpers ──────────────────────────────────────────────────────────

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

interface RepoInfo {
	owner: string;
	name: string;
}

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

function getRepoInfo(cwd: string): RepoInfo | undefined {
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

function parseChecks(statusCheckRollup: unknown[]): CheckStatus {
	const checks: CheckStatus = { total: 0, pass: 0, fail: 0, pending: 0 };
	for (const check of statusCheckRollup) {
		const c = check as Record<string, string>;
		const conclusion = (c.conclusion || "").toUpperCase();
		const status = (c.status || "").toUpperCase();
		const name = c.name || "";

		// Skip ghost checks with no meaningful data
		if (!name && !conclusion && !status) continue;

		checks.total++;
		if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
			checks.pass++;
		} else if (
			conclusion === "FAILURE" ||
			conclusion === "TIMED_OUT" ||
			conclusion === "CANCELLED" ||
			conclusion === "ACTION_REQUIRED"
		) {
			checks.fail++;
		} else if (
			status === "IN_PROGRESS" ||
			status === "QUEUED" ||
			status === "PENDING" ||
			status === "WAITING"
		) {
			checks.pending++;
		} else if (status === "COMPLETED") {
			checks.pass++;
		} else {
			checks.pending++;
		}
	}
	return checks;
}

function getUnresolvedThreadCount(owner: string, name: string, prNumber: number): number {
	try {
		const gql = execSync(
			`gh api graphql -f query='{ repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${prNumber}) { reviewThreads(first: 100) { nodes { isResolved } } } } }'`,
			{ encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
		).trim();
		const data = JSON.parse(gql);
		const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
		return Array.isArray(threads)
			? threads.filter((t: { isResolved: boolean }) => !t.isResolved).length
			: 0;
	} catch {
		return 0;
	}
}

function getPrByNumber(repo: string, prNumber: number): PrInfo | undefined {
	try {
		const json = execSync(
			`gh pr view ${prNumber} --repo ${repo} --json number,title,url,state,statusCheckRollup`,
			{ encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
		).trim();
		if (!json) return undefined;
		const pr = JSON.parse(json);
		if (!pr.number || !pr.url) return undefined;

		const checks = Array.isArray(pr.statusCheckRollup)
			? parseChecks(pr.statusCheckRollup)
			: { total: 0, pass: 0, fail: 0, pending: 0 };

		const [owner, name] = repo.split("/");
		const unresolvedThreads =
			owner && name ? getUnresolvedThreadCount(owner, name, pr.number) : 0;

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

function getPrForBranch(cwd: string, repo?: RepoInfo): PrInfo | undefined {
	try {
		const json = execSync("gh pr view --json number,title,url,state,statusCheckRollup", {
			cwd,
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (!json) {
			debugLog("getPrForBranch: empty response from gh pr view");
			return undefined;
		}
		const pr = JSON.parse(json);
		if (!pr.number || !pr.url) {
			debugLog(`getPrForBranch: missing number/url in response: ${JSON.stringify(pr).slice(0, 200)}`);
			return undefined;
		}

		const checks = Array.isArray(pr.statusCheckRollup)
			? parseChecks(pr.statusCheckRollup)
			: { total: 0, pass: 0, fail: 0, pending: 0 };

		const unresolvedThreads = repo
			? getUnresolvedThreadCount(repo.owner, repo.name, pr.number)
			: 0;

		debugLog(`getPrForBranch: found PR #${pr.number} (${pr.state})`);
		return {
			number: pr.number,
			title: pr.title,
			url: pr.url,
			state: pr.state,
			checks,
			unresolvedThreads,
		};
	} catch (e) {
		debugLog(`getPrForBranch: error: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

const PR_URL_RE = /https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

function parsePrUrl(text: string): { repo: string; number: number } | null {
	const match = text.match(PR_URL_RE);
	return match ? { repo: match[1], number: parseInt(match[2], 10) } : null;
}

function formatStatus(pr: PrInfo, iterateLabel?: string): string {
	const stateIcon = pr.state === "MERGED" ? "🟣" : pr.state === "CLOSED" ? "🔴" : "🟢";
	const parts: string[] = [`${stateIcon} PR #${pr.number}`];

	if (pr.checks.total > 0) {
		if (pr.checks.fail > 0) {
			parts.push(`❌ ${pr.checks.fail}/${pr.checks.total} failed`);
		} else if (pr.checks.pending > 0) {
			parts.push(`⏳ ${pr.checks.pending}/${pr.checks.total} pending`);
		} else {
			parts.push(`✅ ${pr.checks.total} passed`);
		}
	}

	if (pr.unresolvedThreads > 0) {
		parts.push(`💬 ${pr.unresolvedThreads} unresolved`);
	}

	if (iterateLabel) {
		parts.push(iterateLabel);
	}

	parts.push(pr.url);
	return parts.join(" · ");
}

// ── Iteration message builder ───────────────────────────────────────────────

function buildIterationMessage(n: number, max: number): string {
	return `🔄 **PR Iteration ${n}/${max}** (auto-triggered after push)

**Step 1 — Watch CI**
Find the PR number: \`gh pr view --json number -q .number\`

Wait for all CI checks to complete. Poll every 30 seconds:
\`\`\`bash
gh pr checks $PR --json name,state,conclusion
\`\`\`
Keep polling until no checks have \`state\` of \`IN_PROGRESS\`, \`QUEUED\`, \`PENDING\`, or \`WAITING\`.

- **All checks passed** → proceed to Step 2.
- **Any check failed** → for each failed check, show \`gh run view <run-id> --log-failed\` and **STOP**. Do not proceed.
- **Still pending after 15 minutes** → report timeout and **STOP**.

**Step 2 — Wait for bot reviews**
After CI passes, bot reviewers (Copilot, Sentry, CodeRabbit, etc.) need time to post comments.

1. Get the last commit time: \`gh pr view $PR --json commits --jq '.commits[-1].committedDate'\`
2. Check Sentry status: \`gh pr checks $PR --json name,state,conclusion | jq '[.[] | select(.name | test("sentry"; "i"))]'\`
   - If a Sentry check exists and is not completed → poll every 30s until done (max 10 min).
3. Wait until **at least 5 minutes** have passed since the last commit.
4. Once Sentry is done (or absent) AND 5 min have passed → proceed.

**Step 3 — Address review comments**
Read the address-review skill (check the available skills in the system prompt for the file path) and follow its Step 2 through Step 6.

If there are **no unresolved review comments** → report "✅ CI passed, no review comments to address" and **STOP**.

**Important rules:**
- If you commit and push changes, this extension will **automatically** trigger the next iteration. Just stop after pushing — do NOT manually loop.
- Never use \`#N\` in GitHub comments (auto-links to issues). Use "Comment 1" etc.
- Process every comment. Always reply, react (👍 valid / 👎 invalid), and resolve (if confident).`;
}

// ── Extension ───────────────────────────────────────────────────────────────

const STATUS_KEY = "pr-status";
const POLL_INTERVAL = 30_000;
const MAX_ITERATIONS = 10;
const DEBUG_LOG_PATH = "/tmp/pr-iterate-debug.log";

function debugLog(msg: string) {
	try {
		const fs = require("node:fs");
		fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

export default function (pi: ExtensionAPI) {
	// ── Status bar state ──
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastBranch: string | undefined;
	let lastPr: PrInfo | undefined;
	let cachedRepo: RepoInfo | undefined;
	let pinnedPr: { repo: string; number: number } | null = null;
	let latestCtx: ExtensionContext | null = null;

	// ── Iteration state ──
	let autoIterate = true;
	let iterationCount = 0;

	// ── Status bar ──────────────────────────────────────────────────────────

	function iterateLabel(): string | undefined {
		if (!autoIterate) return undefined;
		if (iterationCount === 0) return "🔄 auto";
		return `🔄 ${iterationCount}/${MAX_ITERATIONS}`;
	}

	function showStatus(
		pr: PrInfo | undefined,
		ui: { setStatus: (key: string, value: string | undefined) => void },
	) {
		// Only update lastPr when we get a definitive answer (found or branch changed).
		// undefined from a transient failure should not wipe the status bar.
		if (pr !== undefined) lastPr = pr;
		ui.setStatus(STATUS_KEY, lastPr ? formatStatus(lastPr, iterateLabel()) : undefined);
	}

	function refreshStatus() {
		if (!latestCtx) return;
		// Re-render with current iterate state without re-fetching PR
		if (lastPr) {
			latestCtx.ui.setStatus(STATUS_KEY, formatStatus(lastPr, iterateLabel()));
		}
	}

	function ensureTimer() {
		if (timer) return;
		timer = setInterval(() => {
			if (latestCtx) update(latestCtx.cwd, latestCtx.ui);
		}, POLL_INTERVAL);
	}

	function clearStatus(ui: { setStatus: (key: string, value: string | undefined) => void }) {
		lastPr = undefined;
		ui.setStatus(STATUS_KEY, undefined);
	}

	function update(cwd: string, ui: { setStatus: (key: string, value: string | undefined) => void }) {
		debugLog(`update: cwd=${cwd} lastBranch=${lastBranch} pinnedPr=${JSON.stringify(pinnedPr)} lastPr=#${lastPr?.number ?? "none"}`);
		// If a PR is pinned by URL, use that
		if (pinnedPr) {
			const pr = getPrByNumber(pinnedPr.repo, pinnedPr.number);
			showStatus(pr, ui); // transient failure keeps last known status

			// If the branch now has its own open PR, drop the pin
			if (pr) {
				const branch = getBranch(cwd);
				if (branch && branch !== "HEAD" && branch !== lastBranch) lastBranch = branch;
				if (branch && branch !== "HEAD") {
					cachedRepo = getRepoInfo(cwd);
					const branchPr = getPrForBranch(cwd, cachedRepo);
					if (branchPr && branchPr.state === "OPEN") {
						pinnedPr = null;
						showStatus(branchPr, ui);
					}
				}
			}
			return;
		}

		const branch = getBranch(cwd);
		if (branch !== lastBranch) {
			lastBranch = branch;
			// Branch actually changed — clear stale PR and repo cache
			clearStatus(ui);
			cachedRepo = undefined;
		}
		if (!branch || branch === "HEAD") {
			debugLog(`update: no usable branch (${branch}), clearing`);
			clearStatus(ui);
			return;
		}
		debugLog(`update: branch=${branch}`);

		if (!cachedRepo) cachedRepo = getRepoInfo(cwd);
		showStatus(getPrForBranch(cwd, cachedRepo), ui);
	}

	function tryPinFromUrl(text: string, ctx: ExtensionContext) {
		const parsed = parsePrUrl(text);
		if (!parsed) return;
		if (pinnedPr?.repo === parsed.repo && pinnedPr?.number === parsed.number) return;
		// Don't hijack when branch has an active open PR
		if (lastPr && lastPr.state === "OPEN") return;
		pinnedPr = { repo: parsed.repo, number: parsed.number };
		const pr = getPrByNumber(parsed.repo, parsed.number);
		showStatus(pr, ctx.ui);
	}

	// ── Iteration logic ─────────────────────────────────────────────────────

	function triggerIteration(ctx: ExtensionContext) {
		if (!autoIterate) return;
		if (iterationCount >= MAX_ITERATIONS) {
			ctx.ui.notify(`PR iterate: max iterations (${MAX_ITERATIONS}) reached — disabling`, "warning");
			autoIterate = false;
			refreshStatus();
			return;
		}
		iterationCount++;
		refreshStatus();
		const msg = buildIterationMessage(iterationCount, MAX_ITERATIONS);
		pi.sendUserMessage(msg, { deliverAs: "followUp" });
	}

	const PUSH_RE = /\bgit\s+push\b/;
	const PR_CREATE_RE = /\bgh\s+pr\s+create\b/;

	// ── Events ──────────────────────────────────────────────────────────────

	// Detect agent pushes and PR creation
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const cmd = String(((event as Record<string, unknown>).input as any)?.command ?? "");
		if (!PUSH_RE.test(cmd) && !PR_CREATE_RE.test(cmd)) return;
		if (event.isError) return;

		latestCtx = ctx;
		// Brief delay to let the agent finish its current thought
		setTimeout(() => triggerIteration(ctx), 500);
	});

	// Update context from user input (no auto-pinning — use /pr-iterate pin <url>)
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		latestCtx = ctx;
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		latestCtx = ctx;
	});

	// Start polling
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		update(ctx.cwd, ctx.ui);
		ensureTimer();
	});

	// Reset on session switch — also ensure timer is running
	pi.on("session_switch", async (_event, ctx) => {
		lastBranch = undefined;
		lastPr = undefined;
		cachedRepo = undefined;
		pinnedPr = null;
		iterationCount = 0;
		latestCtx = ctx;
		update(ctx.cwd, ctx.ui);
		ensureTimer();
	});

	// Cleanup
	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("pr-iterate", {
		description: "Toggle or control automatic PR iteration (CI + review addressing)",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "on", label: "on — Enable auto-iteration" },
				{ value: "off", label: "off — Disable auto-iteration" },
				{ value: "run", label: "run — Trigger one iteration now" },
				{ value: "reset", label: "reset — Reset iteration counter" },
				{ value: "status", label: "status — Show current state" },
				{ value: "pin", label: "pin <url> — Pin a specific PR by URL" },
				{ value: "unpin", label: "unpin — Unpin and use branch detection" },
			];
			const filtered = options.filter((o) => o.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (trimmed === "on") {
				autoIterate = true;
				iterationCount = 0;
				refreshStatus();
				ctx.ui.notify("PR auto-iterate: ON", "info");
			} else if (trimmed === "off") {
				autoIterate = false;
				refreshStatus();
				ctx.ui.notify("PR auto-iterate: OFF", "info");
			} else if (trimmed === "run") {
				// Manual trigger — temporarily enable if off
				const wasEnabled = autoIterate;
				autoIterate = true;
				triggerIteration(ctx);
				if (!wasEnabled) autoIterate = false;
			} else if (trimmed === "reset") {
				iterationCount = 0;
				refreshStatus();
				ctx.ui.notify("PR iterate: counter reset to 0", "info");
			} else if (trimmed === "status") {
				const prLabel = lastPr ? `PR #${lastPr.number}` : "no PR detected";
				ctx.ui.notify(
					`Auto-iterate: ${autoIterate ? "ON" : "OFF"} · Iterations: ${iterationCount}/${MAX_ITERATIONS} · ${prLabel}`,
					"info",
				);
			} else if (trimmed.startsWith("pin")) {
				const urlPart = trimmed.slice(3).trim();
				const parsed = parsePrUrl(urlPart);
				if (!parsed) {
					ctx.ui.notify("Usage: /pr-iterate pin <github-pr-url>", "warning");
				} else {
					pinnedPr = { repo: parsed.repo, number: parsed.number };
					const pr = getPrByNumber(parsed.repo, parsed.number);
					showStatus(pr, ctx.ui);
					ctx.ui.notify(`Pinned PR #${parsed.number}`, "info");
				}
			} else if (trimmed === "unpin") {
				pinnedPr = null;
				lastPr = undefined;
				update(ctx.cwd, ctx.ui);
				ctx.ui.notify("Unpinned — using branch detection", "info");
			} else {
				// Toggle
				autoIterate = !autoIterate;
				if (autoIterate) iterationCount = 0;
				refreshStatus();
				ctx.ui.notify(`PR auto-iterate: ${autoIterate ? "ON" : "OFF"}`, "info");
			}
		},
	});
}
