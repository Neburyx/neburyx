/**
 * The grammatical function words that stay on the common-word list although some of them are also surnames: articles, prepositions,
 * conjunctions, pronouns, determiners, auxiliary and modal verbs, question words and the adverbs of negation, place, degree, time and focus (`not`, `here`, `very`, `now`, `then`, `just`, `only`, `still`, `too`, `so`, `ever`, `yet`, `again`, `also`). A closed,
 * written list; every other word that is a name in the public lists is removed.
 */
export const FUNCTION_WORDS: readonly string[] = [
  'a', 'about', 'above', 'across', 'after', 'again', 'against', 'all', 'along', 'also', 'although', 'am', 'among', 'an', 'and', 'another', 'any',
  'are', 'around', 'as', 'at', 'be', 'because', 'been', 'before', 'behind', 'being', 'below', 'beside', 'between', 'beyond', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'down', 'during', 'each', 'ever', 'every', 'few', 'for', 'from', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'inside', 'into', 'is', 'it', 'its', 'just', 'many', 'may', 'me', 'might', 'mine',
  'more', 'most', 'much', 'must', 'my', 'near', 'never', 'no', 'none', 'nor', 'not', 'now', 'of', 'off', 'on', 'only', 'onto', 'or', 'other',
  'our', 'ours', 'out', 'outside', 'over', 'past', 'per', 'several', 'shall', 'she', 'should', 'since', 'so', 'some', 'still', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'though', 'through', 'throughout', 'to', 'too',
  'toward', 'under', 'unless', 'until', 'up', 'upon', 'us', 'very', 'via', 'was', 'we', 'were', 'what', 'when', 'where', 'whether', 'which',
  'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'yet', 'you', 'your', 'yours',
];

/**
 * Ordinary words that are also surnames in the public list and stay on the common-word list by a decision of 2026-11-13, because
 * ordinary questions need them. A closed, named list; every word that is a name and is in neither this list nor `FUNCTION_WORDS` is removed.
 */
export const ORDINARY_WORDS_ALSO_SURNAMES: readonly string[] = ['chain', 'made', 'money', 'payment', 'screen', 'show', 'shows'];
