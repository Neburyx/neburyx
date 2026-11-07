import { OpenDemoCase } from '../first-run/open-demo-case.js';
import { demoCasesOf } from '../first-run/demo-case.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { OPEN_DEMO_CASE_ACTION } from './copy.js';

export function DemoCaseActions() {
  const demoCases = demoCasesOf(answeredData(useShellData().sources)?.items ?? []);
  return demoCases.map((entry) => <OpenDemoCase key={entry.sourceId} entry={entry} label={OPEN_DEMO_CASE_ACTION} offered={demoCases.length} className="link" />);
}
