/**
 * The Edit button on a Global Policies card (AE patch). Rendered only for a
 * stored policy whose registry entry has parameters to edit.
 */

import { Button } from "@/components/ui/button";
import type { DefaultPolicy } from "@/hooks/useDefaultPolicies";
import type { PolicyRegistryEntry } from "@/hooks/usePolicies";
import { AE_PENCIL_ICON, aePolicyEditable } from "@/lib/aePolicyEdit";
import { AeTablerSvg } from "@/lib/aeTablerIcon";

export function AePolicyEditButton({
  policy,
  entry,
  onEdit,
}: {
  policy: DefaultPolicy;
  entry?: PolicyRegistryEntry;
  onEdit: (policy: DefaultPolicy) => void;
}) {
  if (!aePolicyEditable(policy, entry)) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground hover:text-foreground"
      title="Edit policy"
      aria-label={`Edit ${policy.name}`}
      componentId="settings.policies.edit"
      onClick={() => onEdit(policy)}
    >
      <AeTablerSvg node={AE_PENCIL_ICON} className="size-3.5" />
    </Button>
  );
}
