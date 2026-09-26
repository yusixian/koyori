import type { SkillPreference } from "./usage-types.ts";

export type SkillPreferenceAction = "keep" | "review-later" | "revoke";

export interface SkillPreferenceCard {
  id: string;
  skillId: string;
  skillName: string;
  action: SkillPreferenceAction;
  current: SkillPreference | null;
  result: SkillPreference;
  createdAt: string;
  expiresAt: string;
}

export function preferenceAfterAction(
  action: SkillPreferenceAction,
  current: SkillPreference | undefined,
  createdAt: string,
): SkillPreference {
  if (action === "revoke") {
    return { keep: false, reviewAfter: null, firstSeenAt: current?.firstSeenAt ?? createdAt };
  }
  if (action === "keep") {
    return { keep: true, reviewAfter: null, firstSeenAt: current?.firstSeenAt ?? createdAt };
  }
  const reviewDate = new Date(createdAt);
  reviewDate.setUTCDate(reviewDate.getUTCDate() + 30);
  return {
    keep: false,
    reviewAfter: reviewDate.toISOString(),
    firstSeenAt: current?.firstSeenAt ?? createdAt,
  };
}
