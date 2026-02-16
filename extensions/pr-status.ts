/**
 * pr-status - Detects GitHub PR URLs in user input and immediately shows PR status as a widget.
 *
 * When a user pastes or types a message containing a GitHub PR URL like
 * https://github.com/owner/repo/pull/123, the extension immediately fetches
 * PR metadata via `gh` and renders a compact status widget above the editor.
 *
 * The widget shows: title, state, branch, checks, review decision, merge status,
 * and file change stats. It updates periodically while the PR is tracked.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WIDGET_KEY = "pr-status";
const POLL_INTERVAL = 30_000; // 30 seconds

// Match GitHub PR URLs: https://github.com/owner/repo/pull/123
const PR_URL_RE = /https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

interface PrData {
	url: string;
	repo: string;
	number: number;
	title: string;
	state: string;
	headRefName: string;
	baseRefName: string;
	isDraft: boolean;
	mergeable: string;
	mergeStateStatus: string;
	reviewDecision: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	checks: CheckData[];
}

interface CheckData {
	name: string;
	status: string;
	conclusion: string;
	state?: string; // for StatusContext
}

async function fetchPrData(pi: ExtensionAPI, prUrl: string, repo: string, prNumber: number): Promise<PrData | null> {
	try {
		const result = await pi.exec(
			"gh",
			[
				"pr",
				"view",
				String(prNumber),
				"--repo",
				repo,
				"--json",
				"title,state,headRefName,baseRefName,statusCheckRollup,reviewDecision,additions,deletions,changedFiles,isDraft,mergeable,mergeStateStatus",
			],
			{ timeout: 15000 },
		);
		if (result.code !== 0) return null;

		const data = JSON.parse(result.stdout);
		const checks: CheckData[] = (data.statusCheckRollup || []).map((c: Record<string, string>) => ({
			name: c.name || c.context || "unknown",
			status: c.status || "",
			conclusion: c.conclusion || "",
			state: c.state || "",
		}));

		return {
			url: prUrl,
			repo,
			number: prNumber,
			title: data.title || "",
			state: data.state || "",
			headRefName: data.headRefName || "",
			baseRefName: data.baseRefName || "",
			isDraft: data.isDraft || false,
			mergeable: data.mergeable || "",
			mergeStateStatus: data.mergeStateStatus || "",
			reviewDecision: data.reviewDecision || "",
			additions: data.additions || 0,
			deletions: data.deletions || 0,
			changedFiles: data.changedFiles || 0,
			checks,
		};
	} catch {
		return null;
	}
}

function stateIcon(state: string, isDraft: boolean): string {
	if (isDraft) return "📝";
	switch (state) {
		case "OPEN":
			return "🟢";
		case "CLOSED":
			return "🔴";
		case "MERGED":
			return "🟣";
		default:
			return "⬜";
	}
}

function mergeIcon(mergeable: string): string {
	switch (mergeable) {
		case "MERGEABLE":
			return "✅";
		case "CONFLICTING":
			return "⚠️";
		case "UNKNOWN":
			return "❓";
		default:
			return "";
	}
}

function reviewIcon(decision: string): string {
	switch (decision) {
		case "APPROVED":
			return "✅";
		case "CHANGES_REQUESTED":
			return "🔄";
		case "REVIEW_REQUIRED":
			return "👀";
		default:
			return "";
	}
}

function checksSummary(checks: CheckData[]): string {
	if (checks.length === 0) return "";

	let pass = 0;
	let fail = 0;
	let pending = 0;

	for (const c of checks) {
		// CheckRun uses conclusion, StatusContext uses state
		const outcome = c.conclusion || c.state || c.status;
		if (outcome === "SUCCESS" || outcome === "success") {
			pass++;
		} else if (outcome === "FAILURE" || outcome === "failure" || outcome === "ERROR" || outcome === "error") {
			fail++;
		} else {
			pending++;
		}
	}

	const parts: string[] = [];
	if (pass > 0) parts.push(`✅${pass}`);
	if (fail > 0) parts.push(`❌${fail}`);
	if (pending > 0) parts.push(`⏳${pending}`);
	return parts.join(" ");
}

function formatWidget(pr: PrData): string[] {
	const lines: string[] = [];

	const icon = stateIcon(pr.state, pr.isDraft);
	const draftTag = pr.isDraft ? " [DRAFT]" : "";
	const stateTag = pr.state === "MERGED" ? " [MERGED]" : pr.state === "CLOSED" ? " [CLOSED]" : "";
	lines.push(`${icon} PR #${pr.number}: ${pr.title}${draftTag}${stateTag}`);

	const parts: string[] = [];
	parts.push(`${pr.headRefName} → ${pr.baseRefName}`);
	parts.push(`+${pr.additions} -${pr.deletions} (${pr.changedFiles} files)`);

	const merge = mergeIcon(pr.mergeable);
	if (merge) {
		const mergeLabel = pr.mergeable === "CONFLICTING" ? "conflicts" : pr.mergeable === "MERGEABLE" ? "mergeable" : pr.mergeable.toLowerCase();
		parts.push(`${merge} ${mergeLabel}`);
	}

	const review = reviewIcon(pr.reviewDecision);
	if (review) {
		const reviewLabel = pr.reviewDecision.toLowerCase().replace(/_/g, " ");
		parts.push(`${review} ${reviewLabel}`);
	}

	const checksStr = checksSummary(pr.checks);
	if (checksStr) parts.push(checksStr);

	lines.push(`  ${parts.join("  │  ")}`);

	return lines;
}

export default function (pi: ExtensionAPI) {
	let trackedPr: { url: string; repo: string; number: number } | null = null;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let latestCtx: ExtensionContext | null = null;

	function clearWidget() {
		if (latestCtx?.hasUI) {
			latestCtx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	async function updateWidget() {
		if (!trackedPr || !latestCtx?.hasUI) return;

		const pr = await fetchPrData(pi, trackedPr.url, trackedPr.repo, trackedPr.number);
		if (!pr) return;

		latestCtx.ui.setWidget(WIDGET_KEY, formatWidget(pr));

		// Stop polling for terminal states
		if (pr.state === "MERGED" || pr.state === "CLOSED") {
			stopPolling();
		}
	}

	function startTracking(url: string, repo: string, prNumber: number, ctx: ExtensionContext) {
		// Don't restart if already tracking same PR
		if (trackedPr?.url === url) return;

		stopPolling();
		trackedPr = { url, repo, number: prNumber };
		latestCtx = ctx;

		// Show loading state immediately
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, [`⏳ Loading PR #${prNumber} from ${repo}...`]);
		}

		// Fetch and display
		updateWidget();

		// Poll for updates
		pollTimer = setInterval(() => updateWidget(), POLL_INTERVAL);
	}

	function detectPrUrl(text: string): { url: string; repo: string; number: number } | null {
		const match = text.match(PR_URL_RE);
		if (!match) return null;
		return { url: match[0], repo: match[1], number: parseInt(match[2], 10) };
	}

	// Detect PR URLs in user input immediately
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const pr = detectPrUrl(event.text);
		if (pr) {
			startTracking(pr.url, pr.repo, pr.number, ctx);
		}

		return { action: "continue" as const };
	});

	// Also detect in before_agent_start for messages injected by skills/other extensions
	pi.on("before_agent_start", async (event, ctx) => {
		latestCtx = ctx;

		const pr = detectPrUrl(event.prompt);
		if (pr) {
			startTracking(pr.url, pr.repo, pr.number, ctx);
		}
	});

	// Keep ctx fresh
	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;

		// Scan session history for a tracked PR
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (msg?.role !== "user") continue;

			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
						text += " " + (part as { text: string }).text;
					}
				}
			}

			const pr = detectPrUrl(text);
			if (pr) {
				startTracking(pr.url, pr.repo, pr.number, ctx);
			}
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopPolling();
		trackedPr = null;
		clearWidget();
		latestCtx = ctx;
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
	});
}
