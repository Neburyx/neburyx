import { ASSISTANT_TABLE_ANCHOR_WITHHELD, type AssistantFailureKind } from '@neburyx/contracts';

export const ASSISTANT_COPY = {
  title: 'Assistant',
  close: 'Close',
  wide: 'Wide',
  normalWidth: 'Normal width',
  wideBlocked: 'Wide: close the inspector first, so that no panel is covered',
  narrowedForInspector: 'The Assistant is back to its normal width because the inspector is open.',
  clearChat: 'Clear chat',
  popOut: 'Pop out',
  popOutTip: 'Open this chat as a full page in a new window',
  popOutRefused: 'The window could not be opened. Check that this browser allows pop-up windows.',
  popOutOpenHere: 'Open the chat in this window',
  popOutUnreachable: 'The chat is open in a window this window cannot switch to. Use that window, or close it to show the chat here.',
  poppedOutTitle: 'The chat is open in another window',
  poppedOutBody: 'The thread shows in both windows. Selecting a source there highlights the element on this graph.',
  showHere: 'Show the chat here',
  clearTitle: 'Clear this chat?',
  clearBody: 'This deletes the questions and answers of this thread. The graph, notes and views are unchanged.',
  clearWarning: 'This cannot be undone.',
  clearing: 'Clearing…',
  clearFailed: 'Clearing the chat could not be confirmed. It may or may not have been cleared. Try again.',
  clearRefused: 'The chat could not be cleared. Nothing was deleted. Try again.',
  cleared: 'The chat was cleared.',
  pageNote: 'AI-drafted from what this investigation shows. Every sentence cites the graph; check the sources before you rely on it.',
  openGraph: 'Open graph',
  readOnly: 'read-only',
  pageEmptyTitle: (title: string): string => `Ask about ${title}`,
  pageEmptyBody: 'Answers come from what this investigation shows. Every sentence cites a graph element, and nothing here can change the graph.',
  pagePlaceholder: (title: string): string => `Ask about ${title}…`,
  modelLine: (model: string | undefined, entities: number, relationships: number): string => [model === undefined ? undefined : `Model: ${model}`, `${entities.toLocaleString('en-US')} ${entities === 1 ? 'entity' : 'entities'}`, `${relationships.toLocaleString('en-US')} ${relationships === 1 ? 'relationship' : 'relationships'} on the canvas`].filter((part) => part !== undefined).join(' · '),
  pageOpening: 'Opening the investigation…',
  pageNeedsInvestigationTitle: 'Open an investigation first',
  pageNeedsInvestigation: 'The Assistant answers about one investigation. Open an investigation, then come back here.',
  toInvestigations: 'Go to Investigations',
  introTitle: 'Ask about this investigation',
  intro: 'Describe what is on screen, or ask the source a question. Answers cite the elements they rest on.',
  forExample: 'For example',
  introNote: 'It gives no verdict on guilt or intent. It never writes queries.',
  fieldLabel: 'Your message',
  placeholder: 'Ask about this investigation…',
  waitingPlaceholder: 'Waiting for the answer…',
  send: 'Send',
  keys: 'Enter sends, Shift+Enter adds a line, Esc closes.',
  cancel: 'Cancel',
  cancelHint: 'Input is disabled while it runs. Cancel stops the request; nothing more is read once it is stopped.',
  cancelledTitle: 'Cancelled',
  cancelledBody: 'Nothing more was read and nothing was added to the graph. Your message is back in the box.',
  // the sentence of the step in progress; the wording is to be confirmed against frame AS12
  stepRouting: 'Placing your message…',
  stepReadingView: 'Reading your view…',
  stepReading: 'Reading',
  stepReadingFor: 'for',
  overviewHeading: 'What the investigation connects',
  overviewNote: 'An overview of the view, not an assessment.',
  stepAnswering: 'Checking the answer…',
  stepAnsweringBody: 'Every sentence must cite something that was read.',
  stepReadDone: 'Finished reading',
  working: 'Working on it…',
  workingBody: 'Understanding your message and reading the source. This can take a moment.',
  continuing: 'Reading a first page…',
  routeAsk: 'Read from the source',
  routeView: 'From the view',
  routeRefuse: 'Refused',
  clarifyTitle: 'Do you mean …?',
  choiceInvalidTitle: 'Choice no longer valid',
  followUps: 'Follow-ups',
  summaryInvalidTitle: 'Summary no longer attached',
  summaryContext: 'AI case summary',
  summaryContextTag: 'Context',
  summaryNoLonger: 'No longer attached',
  summaryUsedFor: 'Used for this thread only. It is dropped if masking, policy or access changes.',
  summaryAsking: 'Asking about: AI case summary',
  summaryRemove: 'Stop asking about the AI case summary',
  summaryPlaceholder: 'Ask a follow-up…',
  followUpInvalidTitle: 'Follow-up no longer valid',
  followUpInvalid: 'This follow-up is no longer valid. Nothing was read.',
  clarifyCandidates: 'Elements you may mean',
  clarifyStatus: 'Awaiting your choice · nothing was read. These are elements of this investigation.',
  notAnswered: 'Not answered',
  citedElement: 'Element:',
  readCitation: 'Read',
  serverWritten: 'Written by the server',
  noDescriptionTitle: 'About these types',
  aboutType: 'About',
  meaningTitle: 'What these types mean',
  operatorDescription: 'The operator’s description of the type, not a read of the source',
  openFilters: 'Open Filters',
  summarizeView: 'Summarize this view',
  openPaths: 'Open Paths',
  pathsLeftOut: 'Open Paths is left out because this build has no Paths tool.',
  unavailableTitle: 'Not available',
  unavailableBody: 'The assistant is not available because AI is switched off, or no AI provider is configured for this deployment.',
  unavailableNote: 'An administrator can switch AI on or set a provider. Everything else in the workspace works as before.',
  unavailableManual: 'You can still use the manual tools: Filters, Search, Expand and Paths.',
  unavailableField: 'Not available',
  unavailableSend: 'Nothing can be sent.',
  serviceTitle: 'Service unavailable',
  tooLargeTitle: 'Too large',
  limitTitle: 'Stopped at a limit',
  limitTitles: { calls: 'Model calls', steps: 'Stopped at a limit', rows: 'Rows read', time: 'Time', input: 'Too large to send' } as const,
  limitNoteReads: 'Ask a narrower question to go further. Confirming a step never lifts a limit.',
  limitNoteOther: 'Each limit is a setting with a ceiling the server enforces.',
  tryAgain: 'Try again',
  askAgain: 'Ask again',
  continue: 'Continue',
  continueInvalidTitle: 'Continue no longer valid',
  continueInvalid: 'This stop has expired, or the graph or your access changed. Ask the message again.',
  heavyBody: 'This read would be very large, so the assistant stopped before reading it. At least this many match.',
  heavyNote: 'Continue reads a first page only. Or send a narrower message.',
  viewTooLarge: 'The view holds more elements than a message may name. Narrow the view, then send again. Nothing was sent.',
  notAvailableNow: 'The assistant is not available right now.',
  steps: 'Steps',
  notRead: 'not read',
  waitingLabel: 'Waiting for you',
  confirm: 'Confirm',
  skip: 'Skip',
  waitingSkipNote: 'Skip carries on without this read. Confirm counts toward this turn’s limits.',
  waitingNothingRuns: 'Nothing more runs until you choose. Cancel stops the turn.',
  waitingClosed: 'This turn was waiting for a confirmation that is no longer open. Send a new message to go on.',
  confirmationInvalidTitle: 'Confirmation no longer valid',
  heavyStepTitle: 'Heavy step · waiting',
  readsNote: 'Counts are exact, “~ n (estimated)”, “≥ n · lower bound”, or no number when unknown.',
  drafted: 'AI-drafted',
  modelTag: 'Model',
  sources: 'Sources',
  citationNumber: 'Citation',
  sentences: 'Answer from the view',
  sentencesFromReads: 'Answer from the reads',
  coverage: 'Server-authored coverage',
  citeColumn: 'Source',
  copyTable: 'Copy table',
  tableCopied: 'Copied',
  tableCopyFailed: 'Could not copy the table',
  groupHide: '(hide)',
  showAll: 'Show all',
  foldClose: 'Fold the rows again',
  moreNotShownTitle: 'More not shown',
  accessLost: 'You no longer have access to this investigation, so the thread was cleared.',
  maskingTitle: 'Masking changed',
  maskingBody: 'The text of this thread was cleared. Ask again.',
  maskingBodyWithSummary: 'The summary and the text of this thread were cleared. Ask again, or generate the summary again.',
  maskingNoteWithSummary: 'Answers now follow the new masking. Earlier answers were removed from the screen.',
  maskingNote: 'Answers now follow the new masking. Also shown when policy or your access changes.',
  standing: 'The thread is cleared when the investigation closes.',
  newThreadTitle: 'New thread',
  newThreadBody: 'This is a new thread. The previous thread was cleared when the investigation closed.',
  newThreadNote: 'Your graph, notes and saved views are unchanged.',
  storedHeading: 'Earlier in this thread',
  storedNotice: 'Showing the earlier chat of this investigation. It is cleared when the investigation is closed.',
  storedWithheld: 'Masking is on, so this text is not shown.',
  /** Stands for the element a reopened table was listed from when the read withheld its title. */
  storedAnchorWithheld: ASSISTANT_TABLE_ANCHOR_WITHHELD,
  valuesLoading: 'Reading the values of the earlier answers…',
  valuesFailed: 'Some values of the earlier answers could not be read.',
  sourcesLoading: 'Reading the sources…',
  sourcesFailed: 'The sources could not be read.',
  sourceUnavailable: 'Not available',
  highlightedInGraph: 'Highlighted in the graph window',
  selected: 'Selected',
  noGraphWindow: 'No graph window is open for this investigation, so nothing was highlighted.',
  notOnCanvas: 'Not on the canvas',
  selectionNotOnCanvas: 'The element you selected is not on the canvas.',
  graphWindowOpen: 'Graph window open',
  selectHint: 'Select a source to show it on the graph',
  valueUnavailable: '(not available)',
  storedLoading: 'Reading the earlier turns…',
  storedFailed: 'The earlier turns of this thread could not be read.',
  storedAnswered: 'Answered',
  storedRefused: 'Refused',
  sourceChanged: 'The source changed, so messages are paused.',
  thread: 'Conversation',
  you: 'You',
} as const;

const rowsOf = (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'row' : 'rows'}`;
export const showSourceLabel = (number: number): string => `Show source [${number}]`;
export const selectRowLabel = (position: number): string => `Select row ${position} on graph`;

export const foldedRowsText = (count: number): string => `… ${count.toLocaleString('en-US')} more ${count === 1 ? 'row' : 'rows'} …`;
export const moreNotShownText = (shown: number, more: number): string => `${rowsOf(shown)} ${shown === 1 ? 'is' : 'are'} shown. ${more.toLocaleString('en-US')} more ${more === 1 ? 'row was' : 'rows were'} not shown. Narrow the view or ask for a smaller set.`;
export const droppedRowsText = (count: number): string => `${rowsOf(count)} ${count === 1 ? 'was' : 'were'} left out because ${count === 1 ? 'it' : 'they'} did not hold up against the elements cited.`;

export const wordsText = (used: number, limit: number): string => `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} words`;
export const wordsSpoken = (used: number, limit: number): string => `${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} words`;
export const hintText = (limit: number): string => `Your message goes to the model as typed. Up to ${limit.toLocaleString('en-US')} words. ${ASSISTANT_COPY.keys}`;
export const tooLongText = (words: number, limit: number): string => `Your message is ${words.toLocaleString('en-US')} words. The limit is ${limit.toLocaleString('en-US')}. Shorten it and send again.`;
export const TOO_LONG_NOTE = 'Nothing was sent. The count is exact.';

/** The sentence of an `unavailable` answer: what failed and whether a read had started, never a word of the service. */
export function unavailableSentence(kind: AssistantFailureKind, readStarted: boolean): string {
  if (!readStarted) {
    if (kind === 'timeout') return 'The assistant’s service took too long. Nothing was asked and nothing was read.';
    if (kind === 'rate-limit') return 'The assistant’s service is busy. Nothing was asked and nothing was read.';
    return 'The assistant’s service is unavailable. Nothing was asked and nothing was read.';
  }
  if (kind === 'timeout') return 'The read took too long and was stopped. It may have started.';
  if (kind === 'source-unavailable') return 'The source is not available right now. The read may have started.';
  if (kind === 'busy') return 'The source is busy right now. The read may have started.';
  if (kind === 'rate-limit') return 'You have asked too often. The read may have started.';
  return 'The read did not finish. It may have started.';
}

/** The name of the one marker of a row that cites several elements: each element as a single marker names it (number, label, status), in the order of the row's cites. */
export const rowCitationsLabel = (parts: readonly string[]): string => `Citations: ${parts.join("; ")}`;
export const citationRangeLabel = (first: number, last: number): string => `Citations ${first} to ${last}: select on graph and show in Sources`;
export const MARKER_RUN_MIN = 3;
export const sourcesGroupedText = (count: number): string => `${count.toLocaleString('en-US')} sources, grouped by shape`;
export const moreInGroupText = (count: number): string => `${count.toLocaleString('en-US')} more in this group`;
export const GROUP_MEMBERS_SHOWN = 5;
export const pageSourcesText = (count: number): string => `Sources · ${count.toLocaleString('en-US')} ${count === 1 ? 'element' : 'elements'}`;
export const sourcesText = (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'source' : 'sources'}`;
export const earlierText = (count: number): string => `${count.toLocaleString('en-US')} earlier ${count === 1 ? 'turn is' : 'turns are'} not shown.`;
export const causeText = (cause: string): string => `${cause.charAt(0).toUpperCase()}${cause.slice(1).replace(/-/g, ' ')}`;

/** What an earlier answer tells of what the thread did not keep of a result, each in its own unit. */
export const rowsNotKept = (count: number): string => `${count.toLocaleString('en-US')} more ${count === 1 ? 'row is' : 'rows are'} not kept in the thread.`;
export const pathsNotKept = (count: number): string => `${count.toLocaleString('en-US')} more ${count === 1 ? 'path is' : 'paths are'} not kept in the thread.`;
export const linesNotKept = (count: number): string => `${count.toLocaleString('en-US')} more ${count === 1 ? 'count line is' : 'count lines are'} not kept in the thread.`;
export const noticeEntriesNotKept = (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'entry of a notice is' : 'entries of notices are'} not kept in the thread.`;
export const listedText = (count: number): string => `${count.toLocaleString('en-US')} listed in the answer.`;
export const noticeKeptOf = (total: number): string => `This lists only some of the ${total.toLocaleString('en-US')} entries the source gave.`;
