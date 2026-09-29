export { ReviewEngine, ReviewValidationError, parseReviewOutput } from "./engine";
export type { ReviewEngineOptions, ReviewRun, PRReviewInput, PRReviewRun } from "./engine";

export { OpenAICompatibleProvider, LLMError } from "./llm";
export type { LLMProvider, ChatMessage, LLMResult, LLMUsage, OpenAICompatibleOptions } from "./llm";

export { annotatePatch, buildDiffContext, DEFAULT_DIFF_BUDGET_CHARS } from "./diff";
export type { PRFileInput, AnnotatedPatch, DiffContext, DiffContextOptions } from "./diff";

export { buildPRMessages, buildSnippetMessages, newBoundary } from "./prompts";
export type { PRPromptInput } from "./prompts";

export {
  parseRepoConfig,
  createIgnoreMatcher,
  decideConclusion,
  severityAtLeast,
  RepoConfigSchema,
  DEFAULT_REPO_CONFIG,
  DEFAULT_IGNORES,
  CONFIG_FILE_PATH,
} from "./repo-config";
export type { RepoConfig, CheckConclusion } from "./repo-config";

export {
  postReview,
  createCheckRun,
  buildInlineComments,
  formatReviewBody,
  neutralizeMentions,
} from "./github";
export type {
  GitHubClientLike,
  ChecksClientLike,
  InlineComment,
  PostReviewInput,
  PostReviewResult,
  CheckRunInput,
} from "./github";
