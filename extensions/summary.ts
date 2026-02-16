import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];

	const calls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "toolCall" && typeof block.name === "string") {
			calls.push(`Tool \`${block.name}\` called with: ${JSON.stringify(block.arguments ?? {})}`);
		}
	}
	return calls;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;

		const lines: string[] = [];
		const textParts = extractTextParts(content);
		if (textParts.length > 0) {
			const label = role === "user" ? "User" : "Assistant";
			const text = textParts.join("\n").trim();
			if (text) lines.push(`${label}: ${text}`);
		}

		if (role === "assistant") {
			lines.push(...extractToolCallLines(content));
		}

		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	return sections.join("\n\n");
};

const showSummaryModal = async (summary: string, ctx: ExtensionCommandContext) => {
	if (!ctx.hasUI) return;

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(" Session Summary")), 1, 0));
		container.addChild(new Markdown(summary, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", " Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
};

const getGitStatus = async (pi: ExtensionAPI, cwd: string): Promise<string> => {
	try {
		const result = await pi.exec("git", ["status", "--short"], { cwd, timeout: 5000 });
		return result.stdout.trim();
	} catch {
		return "";
	}
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summary", {
		description: "Show a TLDR summary of the current session plus changed files",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Nothing to summarize yet", "warning");
				return;
			}

			if (ctx.hasUI) ctx.ui.notify("Generating summary...", "info");

			// Use a cheap/fast model for summarization
			const model = getModel("anthropic", "claude-sonnet-4-20250514");
			if (!model) {
				if (ctx.hasUI) ctx.ui.notify("Model not found", "error");
				return;
			}

			const apiKey = await ctx.modelRegistry.getApiKey(model);
			if (!apiKey) {
				if (ctx.hasUI) ctx.ui.notify("No API key available", "error");
				return;
			}

			// Fetch git status and LLM summary in parallel
			const [gitStatus, response] = await Promise.all([
				getGitStatus(pi, ctx.cwd),
				complete(
					model,
					{
						messages: [
							{
								role: "user" as const,
								content: [
									{
										type: "text" as const,
										text: [
											"Give me a concise TLDR of this conversation — one or two short paragraphs max.",
											"Cover: what we're working on, what's been done, and what's next.",
											"Be direct, no fluff.",
											"",
											"<conversation>",
											conversationText,
											"</conversation>",
										].join("\n"),
									},
								],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey }
				),
			]);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			const parts = [summary];
			if (gitStatus) {
				parts.push("### Changed files\n```\n" + gitStatus + "\n```");
			}

			await showSummaryModal(parts.join("\n\n"), ctx);
		},
	});
}
