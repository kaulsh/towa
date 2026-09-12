import type { Kysely } from "kysely";

import { z } from "zod";

import type { ChatMessage, LoadedChatModel } from "../ai/types.js";
import type { Database } from "../db/types.js";

import { generateStructured } from "../ai/structured.js";
import { getLogger } from "../logging.js";

/**
 * Ordered fact goals for the adaptive `/init` interview (§6).
 * Ids are stable checklist keys; descriptions guide the interviewer —
 * they are not fixed question text.
 */
const FACT_GOALS = [
  {
    id: "preferred_name",
    description: "What they like to be called",
  },
  {
    id: "location_timezone",
    description: "Where they live / work and their timezone or daily rhythm",
  },
  {
    id: "work_or_study",
    description: "What they do for work or study",
  },
  {
    id: "important_people",
    description: "People who matter (family, partner, close friends, colleagues)",
  },
  {
    id: "interests_hobbies",
    description: "Interests, hobbies, or recurring topics they care about",
  },
  {
    id: "current_focus",
    description: "What they are focused on right now (projects, goals, seasons of life)",
  },
  {
    id: "communication_prefs",
    description: "How they prefer replies (length, tone, formality, emoji, etc.)",
  },
  {
    id: "pets_or_home",
    description: "Pets, living situation, or home context worth remembering",
  },
  {
    id: "health_or_routines",
    description:
      "Standing health notes or daily routines they want remembered (only if volunteered)",
  },
  {
    id: "want_remembered",
    description: "Anything else they explicitly want the agent to never forget",
  },
] as const;

type FactGoalId = (typeof FACT_GOALS)[number]["id"];

const FACT_GOAL_IDS: readonly FactGoalId[] = FACT_GOALS.map((g) => g.id);

const GOAL_ID_SET = new Set<string>(FACT_GOAL_IDS);

function isFactGoalId(id: string): id is FactGoalId {
  return GOAL_ID_SET.has(id);
}

function descriptionForGoal(id: FactGoalId): string {
  const goal = FACT_GOALS.find((g) => g.id === id);
  return goal?.description ?? id;
}

/** Soft target for interviewer pacing (prompt guidance only). */
export const INIT_INTERVIEW_SOFT_TARGET_TURNS = 10;

/** Hard stop — force completion even if goals remain. */
export const INIT_INTERVIEW_HARD_CAP_TURNS = 15;

export type InitInterviewStatus = "idle" | "active" | "completed";

export interface InitInterviewState {
  chatId: string;
  status: InitInterviewStatus;
  turnCount: number;
  resolvedGoals: FactGoalId[];
  pendingGoals: FactGoalId[];
  updatedAt: number;
}

/**
 * Split ack vs question so local models can't "finish" a turn with only
 * thanks — when done=false the harness always sends a follow-up question.
 */
const InterviewerOutputSchema = z.object({
  done: z.boolean(),
  /** Brief thanks / paraphrase; null when opening or nothing to ack. */
  acknowledgment: z.string().nullable().default(null),
  /**
   * Exactly one question targeting a pending goal. Required when done=false;
   * null only when done=true.
   */
  question: z.string().nullable().default(null),
  // Required + nullable: OpenAI structured-outputs reject bare `.optional()`.
  resolved_goal_ids: z.array(z.string()).nullable().default(null),
});

type InterviewerOutput = z.infer<typeof InterviewerOutputSchema>;

const HARD_CAP_REPLY =
  "Thanks — that's enough for now. I'll remember what we've covered so far. You can /init again later if you want to fill in more.";

/** Harness-owned closing line when the interview completes normally (goals done). */
const COMPLETED_REPLY =
  "Thanks — I've gathered what I need for now and will remember it. Just keep chatting naturally; you can run /init again anytime to add more.";

function fallbackQuestion(goalId: FactGoalId): string {
  return `Next — ${descriptionForGoal(goalId)}?`;
}

/** Compose an in-progress reply; never leave an active interview without a question. */
function composeInterviewReply(
  out: InterviewerOutput,
  pendingAfter: readonly FactGoalId[],
): string {
  // Completion closings are owned by the harness (COMPLETED_REPLY / HARD_CAP_REPLY),
  // not the model's acknowledgment — avoids bare "Understood." endings.
  if (out.done || pendingAfter.length === 0) {
    return COMPLETED_REPLY;
  }

  const ack = out.acknowledgment?.trim() ?? "";
  let question = out.question?.trim() ?? "";
  if (!question || !question.includes("?")) {
    question = fallbackQuestion(pendingAfter[0]!);
  }

  return ack ? `${ack} ${question}` : question;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseGoalIds(json: string): FactGoalId[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is FactGoalId => typeof id === "string" && isFactGoalId(id));
  } catch {
    return [];
  }
}

function pendingFromResolved(resolved: readonly FactGoalId[]): FactGoalId[] {
  const resolvedSet = new Set(resolved);
  return FACT_GOAL_IDS.filter((id) => !resolvedSet.has(id));
}

function emptyState(chatId: string): InitInterviewState {
  return {
    chatId,
    status: "idle",
    turnCount: 0,
    resolvedGoals: [],
    pendingGoals: [...FACT_GOAL_IDS],
    updatedAt: nowSec(),
  };
}

export async function loadInitInterviewState(
  db: Kysely<Database>,
  chatId: string,
): Promise<InitInterviewState> {
  const row = await db
    .selectFrom("init_interview")
    .selectAll()
    .where("chat_id", "=", chatId)
    .executeTakeFirst();

  if (!row) return emptyState(chatId);

  const resolvedGoals = parseGoalIds(row.resolved_goals);
  return {
    chatId: row.chat_id,
    status: row.status as InitInterviewStatus,
    turnCount: row.turn_count,
    resolvedGoals,
    pendingGoals: parseGoalIds(row.pending_goals),
    updatedAt: row.updated_at,
  };
}

/** Persist interview state (also used by the harness to rewind on late-arrival regenerate). */
export async function saveInitInterviewState(
  db: Kysely<Database>,
  state: InitInterviewState,
): Promise<void> {
  const updatedAt = nowSec();
  await db
    .insertInto("init_interview")
    .values({
      chat_id: state.chatId,
      status: state.status,
      turn_count: state.turnCount,
      resolved_goals: JSON.stringify(state.resolvedGoals),
      pending_goals: JSON.stringify(state.pendingGoals),
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.column("chat_id").doUpdateSet({
        status: state.status,
        turn_count: state.turnCount,
        resolved_goals: JSON.stringify(state.resolvedGoals),
        pending_goals: JSON.stringify(state.pendingGoals),
        updated_at: updatedAt,
      }),
    )
    .execute();
}

/** Soft context: a few existing node names, if any — never required. */
async function loadKgNameHints(db: Kysely<Database>, limit = 24): Promise<string[]> {
  const rows = await db
    .selectFrom("kg_nodes")
    .select("canonical_name")
    .orderBy("canonical_name")
    .limit(limit)
    .execute();
  return rows.map((r) => r.canonical_name).filter((n) => n.trim().length > 0);
}

function buildInterviewerSystemPrompt(input: {
  pendingGoals: readonly FactGoalId[];
  resolvedGoals: readonly FactGoalId[];
  kgHints: readonly string[];
  mode: "start" | "answer";
  turnCount: number;
}): string {
  const pendingBlock =
    input.pendingGoals.length === 0
      ? "(none left)"
      : input.pendingGoals.map((id) => `- ${id}: ${descriptionForGoal(id)}`).join("\n");

  const resolvedBlock =
    input.resolvedGoals.length === 0 ? "(none yet)" : input.resolvedGoals.join(", ");

  const hintsBlock =
    input.kgHints.length === 0
      ? "(empty knowledge graph — treat all pending goals as unknown)"
      : input.kgHints.join(", ");

  return [
    "You are running a short adaptive onboarding interview for a personal memory agent.",
    "Collect only the pending fact goals below — one goal per turn.",
    "",
    "Output JSON fields:",
    "- acknowledgment: short thanks/paraphrase of the user's last answer, or null on opening / when nothing to ack.",
    "- question: exactly ONE clear question (must include '?') about a still-pending goal, or null only when done=true.",
    "- resolved_goal_ids: goal id(s) the user's latest message actually answered; use [] or null if none.",
    "- done: true only when every pending goal is covered or asking further would be empty/useless.",
    "",
    "Hard rules:",
    "- When done=false you MUST set question to a real follow-up — never acknowledgment-only.",
    "- Do NOT dump a questionnaire or ask multiple questions in one turn.",
    "- Prefer the first unresolved pending goal unless the user just volunteered something else.",
    "- On answer turns, if they clearly answered a pending goal, include that id in resolved_goal_ids (e.g. preferred_name).",
    `Soft target: about ${INIT_INTERVIEW_SOFT_TARGET_TURNS} turns; hard cap is ${INIT_INTERVIEW_HARD_CAP_TURNS}.`,
    "Keep wording concise and conversational.",
    "",
    `Mode: ${input.mode === "start" ? "opening — set acknowledgment=null and ask the first useful question" : "follow-up after a user answer — ack briefly, resolve covered goals, ask the next question"}`,
    `Interview turn count so far (user answers): ${input.turnCount}`,
    "",
    "Pending goals:",
    pendingBlock,
    "",
    "Already resolved goal ids:",
    resolvedBlock,
    "",
    "Existing memory node names (soft hints only — do not assume details):",
    hintsBlock,
    "",
    "Known goal catalog (for id spelling only):",
    FACT_GOALS.map((g) => `- ${g.id}: ${g.description}`).join("\n"),
  ].join("\n");
}

function mergeResolved(
  existing: readonly FactGoalId[],
  fromModel: readonly string[] | null,
  pending: readonly FactGoalId[],
): FactGoalId[] {
  const pendingSet = new Set(pending);
  const next = new Set(existing);
  for (const id of fromModel ?? []) {
    if (isFactGoalId(id) && (pendingSet.has(id) || next.has(id))) {
      next.add(id);
    }
  }
  return FACT_GOAL_IDS.filter((id) => next.has(id));
}

/**
 * Local models often ack without listing resolved_goal_ids. Each answer turn
 * should advance at least the leading pending goal so we don't re-ask forever.
 */
function resolvedIdsForAnswerTurn(
  fromModel: readonly string[] | null,
  pending: readonly FactGoalId[],
): string[] {
  const listed = (fromModel ?? []).filter((id) => isFactGoalId(id));
  if (listed.length > 0) return listed;
  const lead = pending[0];
  return lead ? [lead] : [];
}

async function runInterviewer(input: {
  chatModel: LoadedChatModel;
  pendingGoals: readonly FactGoalId[];
  resolvedGoals: readonly FactGoalId[];
  kgHints: readonly string[];
  mode: "start" | "answer";
  turnCount: number;
  userContent: string;
}): Promise<InterviewerOutput> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildInterviewerSystemPrompt({
        pendingGoals: input.pendingGoals,
        resolvedGoals: input.resolvedGoals,
        kgHints: input.kgHints,
        mode: input.mode,
        turnCount: input.turnCount,
      }),
    },
    { role: "user", content: input.userContent },
  ];

  const { value } = await generateStructured(input.chatModel, messages, InterviewerOutputSchema);
  return value;
}

export async function cancelInitInterview(db: Kysely<Database>, chatId: string): Promise<void> {
  const state = await loadInitInterviewState(db, chatId);
  state.status = "idle";
  // Keep resolvedGoals; stop asking. Pending recomputed for a future /init.
  state.pendingGoals = pendingFromResolved(state.resolvedGoals);
  await saveInitInterviewState(db, state);
}

/**
 * Start or resume the init interview: recompute pending goals and ask
 * the first/next question via the structured interviewer. Skips retrieval.
 */
export async function startOrResumeInitInterview(input: {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  chatId: string;
}): Promise<string> {
  const { db, chatModel, chatId } = input;
  const log = getLogger("init-interview");

  const state = await loadInitInterviewState(db, chatId);
  state.pendingGoals = pendingFromResolved(state.resolvedGoals);

  if (state.pendingGoals.length === 0) {
    state.status = "completed";
    await saveInitInterviewState(db, state);
    return "I already have the basics covered from earlier. Just talk naturally — or tell me anything new you want remembered.";
  }

  // Fresh start resets turn count; resume of an active interview keeps it.
  if (state.status !== "active") {
    state.turnCount = 0;
  }
  state.status = "active";

  const kgHints = await loadKgNameHints(db);
  const out = await runInterviewer({
    chatModel,
    pendingGoals: state.pendingGoals,
    resolvedGoals: state.resolvedGoals,
    kgHints,
    mode: "start",
    turnCount: state.turnCount,
    userContent: "[Interview start/resume — ask one useful opening question about a pending goal.]",
  });

  const resolved = mergeResolved(state.resolvedGoals, out.resolved_goal_ids, state.pendingGoals);
  state.resolvedGoals = resolved;
  state.pendingGoals = pendingFromResolved(resolved);

  if (out.done || state.pendingGoals.length === 0) {
    state.status = "completed";
  }

  await saveInitInterviewState(db, state);
  const reply =
    state.status === "completed" ? COMPLETED_REPLY : composeInterviewReply(out, state.pendingGoals);
  log.info(
    {
      chatId,
      status: state.status,
      pending: state.pendingGoals.length,
      turnCount: state.turnCount,
      replyPreview: reply.slice(0, 120),
    },
    "init interview started/resumed",
  );

  return reply;
}

/**
 * Treat the user message as an interview answer. Increments turn_count;
 * hard-caps at INIT_INTERVIEW_HARD_CAP_TURNS.
 */
export async function continueInitInterview(input: {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  chatId: string;
  userMessage: string;
}): Promise<string> {
  const { db, chatModel, chatId, userMessage } = input;
  const log = getLogger("init-interview");

  const state = await loadInitInterviewState(db, chatId);
  if (state.status !== "active") {
    return "No init interview is in progress. Send /init to start one.";
  }

  state.turnCount += 1;
  state.pendingGoals = pendingFromResolved(state.resolvedGoals);

  // Safety: already at/over cap (e.g. prior crash) — wrap up without another LLM call.
  if (state.turnCount > INIT_INTERVIEW_HARD_CAP_TURNS) {
    state.status = "completed";
    await saveInitInterviewState(db, state);
    log.info({ chatId, turnCount: state.turnCount }, "init interview hard-capped");
    return HARD_CAP_REPLY;
  }

  const kgHints = await loadKgNameHints(db);
  const out = await runInterviewer({
    chatModel,
    pendingGoals: state.pendingGoals,
    resolvedGoals: state.resolvedGoals,
    kgHints,
    mode: "answer",
    turnCount: state.turnCount,
    userContent: userMessage.trim() || "(empty message)",
  });

  const resolved = mergeResolved(
    state.resolvedGoals,
    resolvedIdsForAnswerTurn(out.resolved_goal_ids, state.pendingGoals),
    state.pendingGoals,
  );
  state.resolvedGoals = resolved;
  state.pendingGoals = pendingFromResolved(resolved);

  const hitHardCap = state.turnCount >= INIT_INTERVIEW_HARD_CAP_TURNS;
  if (out.done || state.pendingGoals.length === 0 || hitHardCap) {
    state.status = "completed";
  }

  await saveInitInterviewState(db, state);
  const reply =
    state.status === "completed"
      ? hitHardCap && state.pendingGoals.length > 0 && !out.done
        ? HARD_CAP_REPLY
        : COMPLETED_REPLY
      : composeInterviewReply(out, state.pendingGoals);

  log.info(
    {
      chatId,
      status: state.status,
      pending: state.pendingGoals.length,
      turnCount: state.turnCount,
      newlyResolved: out.resolved_goal_ids,
      hitHardCap,
      usedFallbackQuestion:
        !out.done && state.pendingGoals.length > 0 && !(out.question?.includes("?") ?? false),
      replyPreview: reply.slice(0, 120),
    },
    "init interview turn",
  );

  return reply;
}
