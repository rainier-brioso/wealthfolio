import type { DraftActivity } from "../context/import-context";

/** A source operation must not be applied with only some of its cash/security legs. */
export function hasPartialSourceOperation(drafts: DraftActivity[]): boolean {
  const groups = new Map<string, { included: boolean; excluded: boolean }>();
  for (const draft of drafts) {
    if (!draft.sourceOperationGroup) continue;
    const group = groups.get(draft.sourceOperationGroup) ?? { included: false, excluded: false };
    const excluded = !(
      draft.status === "valid" ||
      draft.status === "warning" ||
      (draft.status === "duplicate" && draft.forceImport)
    );
    group.excluded ||= excluded;
    group.included ||= !excluded;
    groups.set(draft.sourceOperationGroup, group);
  }
  return [...groups.values()].some((group) => group.included && group.excluded);
}
