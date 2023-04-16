import { Match, Show, Switch, createMemo, splitProps } from "solid-js";
import { formatTimestamp, useSelectedRecording } from "./EncounterSelector";
import {
  DungeonEncounter,
  Encounter,
  ManualEncounter,
  RaidEncounter,
} from "./saved_variables";

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  return `${seconds}s`;
}

function EncounterTimeDetails(encounter: Encounter) {
  return (
    <>
      <dt>Start Time</dt>
      <dd>{formatTimestamp(encounter.startTime)}</dd>
      <dt>End Time</dt>
      <dd>{formatTimestamp(encounter.endTime)}</dd>
      <dt>Duration</dt>
      <dd>{formatDuration(encounter.endTime - encounter.startTime)}</dd>
    </>
  );
}

function RaidEncounterDetails(encounter: RaidEncounter) {
  return (
    <dl>
      <dt>Encounter ID</dt>
      <dd>{encounter.encounterId}</dd>
      <dt>Encounter Name</dt>
      <dd>{encounter.encounterName}</dd>
      <EncounterTimeDetails {...encounter} />
      <dt>Result</dt>
      <dd>{encounter.success ? "Kill" : "Wipe"}</dd>
      <dt>Group Size</dt>
      <dd>{encounter.groupSize}</dd>
      <dt>Difficulty ID</dt>
      <dd>{encounter.difficultyId}</dd>
    </dl>
  );
}

function DungeonEncounterDetails(encounter: DungeonEncounter) {
  return (
    <dl>
      <dt>Map ID</dt>
      <dd>{encounter.mapId}</dd>
      <EncounterTimeDetails {...encounter} />
      <dt>Result</dt>
      <dd>{encounter.success ? "Kill" : "Wipe"}</dd>
    </dl>
  );
}

function ManualEncounterDetails(encounter: ManualEncounter) {
  return (
    <dl>
      <dt>Manual Test</dt>
      <dd>True</dd>
      <EncounterTimeDetails {...encounter} />
    </dl>
  );
}

export default function EncounterDetails() {
  const recording = useSelectedRecording();

  const encounter = createMemo(() => recording()?.encounter);

  return (
    <Show when={encounter()}>
      <details>
        <summary>Encounter Details</summary>
        <Switch>
          <Match when={encounter()?.kind === "raid"}>
            <RaidEncounterDetails {...(encounter() as RaidEncounter)} />
          </Match>
          <Match when={encounter()?.kind === "mythicplus"}>
            <DungeonEncounterDetails {...(encounter() as DungeonEncounter)} />
          </Match>
          <Match when={encounter()?.kind === "manual"}>
            <ManualEncounterDetails {...(encounter() as ManualEncounter)} />
          </Match>
        </Switch>
      </details>
    </Show>
  );
}
