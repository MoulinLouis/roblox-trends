import Link from "next/link";
import type { RisingGame } from "@/db/radar";
import { ACTIVE_SET_CONFIG, RADAR_CONFIG } from "@/lib/config";
import { formatCompact, formatCount, formatDay, formatElapsed, formatHours, formatMultiplier } from "@/lib/format";
import { GameIcon } from "./GameIcon";

export function RisingGamesTable({ games, asOf }: { games: RisingGame[]; asOf: Date }) {
  if (games.length === 0) return <div className="empty">No game matches these filters.</div>;
  const { start, middle, end } = RADAR_CONFIG.velocityThresholds;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>CCU</th>
            <th>Peak</th>
            <th>vs last week</th>
            <th>vs day before</th>
            <th>{formatCompact(start)} → {formatCompact(middle)}</th>
            <th>{formatCompact(middle)} → {formatCompact(end)}</th>
            <th>Signals</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <tr key={game.universeId}>
              <td>
                <Link className="game-cell" href={`/games/${game.universeId}`}>
                  <GameIcon url={game.iconUrl} name={game.name} />
                  <div>
                    <strong>{game.name}</strong>
                    <span>Created {formatDay(game.robloxCreatedAt)} · {formatElapsed(game.robloxCreatedAt, asOf)} old</span>
                  </div>
                </Link>
              </td>
              <td>
                <strong>{formatCount(game.ccuLast ?? game.ccuAverage)}</strong>
                <span className="table-subline">
                  {formatCount(game.ccuAverage)} on average over {game.samples} h
                  {game.ccuLastAt ? ` · read ${formatElapsed(game.ccuLastAt, asOf)} ago` : ""}
                </span>
              </td>
              <td>{formatCount(game.ccuPeak)}</td>
              <td><WeekGrowth game={game} /></td>
              <td>
                {formatMultiplier(game.dayGrowth)}
                <span className="table-subline">{game.previousSamples} h the day before</span>
              </td>
              <td>{formatHours(game.hoursToMiddle)}</td>
              <td>{formatHours(game.hoursToEnd)}</td>
              <td>
                {game.isEvent ? (
                  <span
                    className="badge event"
                    title={`Peak ${formatCount(game.windowPeak)} against a median of ${formatCount(game.windowMedian)}, back to ${formatCount(game.windowLast)} in the last hour`}
                  >
                    Event
                  </span>
                ) : null}
                <span className="table-subline">First seen at {formatCount(game.firstSeenCcu)} CCU</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "tracked": the game's share against the same hours a week earlier; "new": created since; "untracked": the radar read
// some game in every hour a week earlier but not this one, so it had fewer players than the active-set minimum;
// "unknown": no baseline (v1 hours).
function WeekGrowth({ game }: { game: RisingGame }) {
  switch (game.weekBaseline) {
    case "tracked":
      return (
        <>
          {game.weekGrowth === null ? "from 0" : formatMultiplier(game.weekGrowth)}
          <span className="table-subline">{game.weekSamples} h paired a week earlier</span>
        </>
      );
    case "new":
      return <span className="badge new">New</span>;
    case "untracked":
      return (
        <>
          from under {formatCount(ACTIVE_SET_CONFIG.minimumCcu)}
          <span className="table-subline">Below the tracking minimum a week earlier</span>
        </>
      );
    default:
      return <>—<span className="table-subline">No reading a week earlier</span></>;
  }
}
