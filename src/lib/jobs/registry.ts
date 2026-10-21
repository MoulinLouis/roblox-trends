import { RobloxClient } from "@/lib/api/roblox";
import { getRolimonsGames } from "@/lib/api/rolimons";
import { ROBLOX_REGION } from "@/lib/config";
import { createCensusJob } from "./census";
import type { JobDefinition } from "./runner";

export function createJobs(): JobDefinition[] {
  const roblox = new RobloxClient(ROBLOX_REGION.country, ROBLOX_REGION.device);
  return [createCensusJob({ fetchGames: getRolimonsGames, roblox })];
}
