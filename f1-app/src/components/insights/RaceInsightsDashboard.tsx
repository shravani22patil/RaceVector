import type { ViewKey } from "../../lib/constants";
import Verdicts from "./Verdicts";
import DriversCard from "./DriversCard";
import LapEvolutionCard from "./LapEvolutionCard";
import TruePaceCard from "./TruePaceCard";

export default function RaceInsightsDashboard({ onOpenTab }: { onOpenTab: (tab: ViewKey) => void }) {
  return (
    <div aria-label="Race Insights dashboard">
      <div style={{ margin: "2px 0 12px" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Race Insights</h2>
        <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--text-mute)" }}>
          Race highlights, lap-by-lap pace and the leading clean-lap pace rankings.
        </p>
      </div>
      <Verdicts limit={3} onOpenTab={onOpenTab} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 10, alignItems: "start" }}>
        <LapEvolutionCard compact />
        <TruePaceCard compact />
      </div>
      <DriversCard />
    </div>
  );
}
