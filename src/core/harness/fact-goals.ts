/**
 * Ordered fact goals for the adaptive `/init` interview (§6).
 * Ids are stable checklist keys; descriptions guide the interviewer —
 * they are not fixed question text.
 */
export const FACT_GOALS = [
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
    description: "Standing health notes or daily routines they want remembered (only if volunteered)",
  },
  {
    id: "want_remembered",
    description: "Anything else they explicitly want the agent to never forget",
  },
] as const;

export type FactGoalId = (typeof FACT_GOALS)[number]["id"];

export const FACT_GOAL_IDS: readonly FactGoalId[] = FACT_GOALS.map((g) => g.id);

const GOAL_ID_SET = new Set<string>(FACT_GOAL_IDS);

export function isFactGoalId(id: string): id is FactGoalId {
  return GOAL_ID_SET.has(id);
}

export function descriptionForGoal(id: FactGoalId): string {
  const goal = FACT_GOALS.find((g) => g.id === id);
  return goal?.description ?? id;
}
