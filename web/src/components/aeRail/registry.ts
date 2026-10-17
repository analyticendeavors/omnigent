// Which component draws each session rail section.

import type { ComponentType } from "react";
import type { AeRailSectionId, AeRailSectionProps } from "@/lib/aeSessionRail";
import { AeRailTriage } from "./AeRailTriage";
import { AeRailEnvironment } from "./AeRailEnvironment";
import { AeRailContext } from "./AeRailContext";
import { AeRailAgents } from "./AeRailAgents";
import { AeRailScheduled } from "./AeRailScheduled";
import { AeRailUsage } from "./AeRailUsage";
import { AeRailConnectors } from "./AeRailConnectors";
import { AeRailSentFiles } from "./AeRailSentFiles";
import { AeRailOutputs } from "./AeRailOutputs";
import { AeRailChanges } from "./AeRailChanges";

export const AE_RAIL_COMPONENTS: Record<AeRailSectionId, ComponentType<AeRailSectionProps>> = {
  triage: AeRailTriage,
  environment: AeRailEnvironment,
  context: AeRailContext,
  agents: AeRailAgents,
  scheduled: AeRailScheduled,
  usage: AeRailUsage,
  connectors: AeRailConnectors,
  sent: AeRailSentFiles,
  outputs: AeRailOutputs,
  changes: AeRailChanges,
};
