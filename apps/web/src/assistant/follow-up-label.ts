import { humanize } from '../ask/text.js';
import type { FollowUp } from './assistant-session.js';

export const followUpLabel = (followUp: FollowUp): string => `${humanize(followUp.choice.intent)} · ${followUp.titles.join(', ')}`;
