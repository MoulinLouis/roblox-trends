import { RobloxClient } from "@/lib/api/roblox";
import { getRolimonsGames } from "@/lib/api/rolimons";
import { ROBLOX_REGION } from "@/lib/config";
import { createCensusJob } from "./census";
import { createChartsJob } from "./charts";
import { createExploreJob } from "./explore";
import { createPollJob } from "./poll";
import type { JobDefinition } from "./runner";
import { createThumbnailsJob } from "./thumbnails";
import { createVotesJob } from "./votes";

export function createJobs(): JobDefinition[] {
  const roblox = new RobloxClient(ROBLOX_REGION.country, ROBLOX_REGION.device);
  return [
    createCensusJob({ fetchGames: getRolimonsGames, roblox }),
    createPollJob({ roblox }),
    createVotesJob({ roblox }),
    createChartsJob({ roblox }),
    createExploreJob({ roblox }),
    createThumbnailsJob({ roblox }),
  ];
}
