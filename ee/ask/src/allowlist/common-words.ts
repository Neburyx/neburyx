import { FUNCTION_WORDS, ORDINARY_WORDS_ALSO_SURNAMES } from './function-words.js';

export const COMMON_WORDS_NOTE = [
  'The words are written in this repository: grammatical function words and general words.',
  'Every word that is a surname in the public list below is removed, except the closed set of function words in FUNCTION_WORDS (articles, prepositions, conjunctions, pronouns, determiners, auxiliary and modal verbs, question words, and the adverbs not, here, very, now, then, just, only, still, too, so, ever, yet, again, also), which stays because a question cannot be put without it.',
  'Seven ordinary words that are also surnames stay by a decision of 2026-11-13, because ordinary questions need them (ORDINARY_WORDS_ALSO_SURNAMES): chain, made, money, payment, screen, show, shows.',
  'Public name lists used: US Census Bureau, "Frequently Occurring Surnames from the 2010 Census" (surnames held by at least 100 people), file Names_2010Census.csv from www2.census.gov/topics/genealogy/2010surnames/names.zip, downloaded 2026-11-13 (archive sha-256 117c41cb4668727b7627b2845b6df3f83eb2a22a1813f42c0ff4bdcab86de135); 162,253 names after the row "all other names" is dropped; no cutoff beyond the Bureau\'s own.',
  'Licence terms: a US federal statistical product; the Bureau\'s page on citing its data asks that the Census Bureau be named as the source; no other licence text was found on the file\'s pages.',
  'Given names: not yet removed (a second list is awaited), so a given name that is also an ordinary word can still be on this list.',
  'Residual risks: a function word that is also a surname passes as the word; a name missing from the lists passes if it is a listed word; a form of a vocabulary word can also be a surname; a date of birth written as YYYY-MM-DD is a date and is allowed.',
].join('\n');

export const COMMON_WORDS_VERSION = 'common-words-2';

const WORDS: readonly string[] = [
  'a', 'about', 'above', 'across', 'after', 'again', 'against', 'all', 'along', 'already', 'also', 'although', 'always', 'am', 'among',
  'an', 'and', 'another', 'answer', 'answers', 'any', 'are', 'around', 'as', 'at', 'bad', 'be', 'because', 'been', 'before',
  'behind', 'being', 'below', 'beside', 'between', 'beyond', 'biggest', 'both', 'but', 'by', 'can', 'chains', 'changed', 'closed', 'closest',
  'clusters', 'connect', 'connected', 'connecting', 'connection', 'connections', 'connects', 'could', 'create', 'created',
  'customers', 'cycle', 'cycles', 'did', 'different', 'display', 'displayed', 'do', 'does', 'down', 'duplicate', 'duplicates', 'during',
  'each', 'earliest', 'either', 'ended', 'entities', 'entity', 'event', 'events', 'ever', 'every', 'few', 'fewest', 'find',
  'finding', 'finds', 'flagged', 'for', 'fraudulent', 'from', 'get', 'give', 'got', 'greatest', 'groups', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'higher', 'highest', 'him', 'his', 'hops', 'hours', 'how', 'i', 'if', 'in',
  'inside', 'into', 'is', 'it', 'item', 'items', 'its', 'just', 'largest', 'latest', 'least', 'linked', 'listed', 'lists', 'looks', 'loops',
  'lowest', 'many', 'may', 'me', 'might', 'mine', 'month', 'months', 'more', 'most', 'move', 'moved', 'much', 'multiple', 'must',
  'mutual', 'my', 'name', 'near', 'nearby', 'neither', 'never', 'newest', 'next', 'no', 'none', 'nor', 'not', 'now', 'number', 'of', 'off',
  'often', 'oldest', 'on', 'only', 'onto', 'open', 'opened', 'or', 'other', 'others', 'our', 'ours', 'out', 'outside', 'over', 'past',
  'paths', 'payments', 'per', 'please', 'previous', 'question', 'questions', 'quickly', 'quite', 'receive', 'received', 'recent', 'recently',
  'reference', 'references', 'relate', 'related', 'relations', 'relationship', 'relationships', 'repeat', 'repeated', 'result', 'results',
  'risky', 'routes', 'same', 'searched', 'searches', 'second', 'sent', 'several', 'shall', 'shared', 'sharing', 'she', 'should', 'showing',
  'similar', 'since', 'smallest', 'so', 'some', 'sometimes', 'started', 'steps', 'still', 'stop', 'stopped', 'such', 'suspicious', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'things', 'this', 'those', 'though',
  'through', 'throughout', 'to', 'today', 'told', 'too', 'total', 'toward', 'transfer', 'transfers', 'type', 'types',
  'under', 'unique', 'unless', 'until', 'unusual', 'unusually', 'up', 'upon', 'us', 'used', 'user', 'users', 'uses', 'using', 'value',
  'values', 'very', 'via', 'wanted', 'wants', 'was', 'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who', 'whom',
  'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'year', 'yesterday', 'yet', 'you', 'your', 'yours'
];

export const COMMON_WORDS: readonly string[] = [...new Set([...FUNCTION_WORDS, ...ORDINARY_WORDS_ALSO_SURNAMES, ...WORDS])].sort();
