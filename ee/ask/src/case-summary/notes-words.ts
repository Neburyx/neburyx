/**
 * Bump the version when a word is added or removed: a token sealed under another version is refused at the copy.
 *
 * Version 2: ordinary words that name nothing and carry no value were added, after real drafts had no storable sentence. They were taken from the words those drafts were refused on (a field's kind: city, country, region, street;
 * the words of a description: titled, id, people, movement) and from standard English function and structural words. The safety rule is unchanged: a value comes in only as a slot of a cited element, so no word added here can carry
 * a fact; no digit, number word, ordinal, month, weekday, relative-time or quantity word, and no proper noun or name of a domain, was added.
 */
export const NOTES_WORD_LIST_VERSION = 2;

/**
 * The only words stored AI notes may hold besides placeholders. Lower case, no digits. It has no number word, ordinal, month or weekday name, relative-time word or quantity word, vague ones
 * included: a number, a date or an amount can be stored only as a slot that is recomputed for each viewer.
 */
export const NOTES_WORDS: ReadonlySet<string> = new Set(
  `a about above across after against along also although among an and appears are around as at be became because been before being below between beyond but by can could did do does during either else for from had has have having here how however if in into is it its itself just like made make might must neither nor not of off on only onto or our out over per same shared should since so than that the their them then there these they this those through to together too under until up upon via was were what when where whether which while who whom whose why will with within without would yet
   added appear appeared associated based belongs belong carries carried cited connected connects contains contain created describes described distinct drawn exists exist found given gives held holds hold identified includes included indicates joined known lacks lists linked links located marked mentioned names named noted observed opened owned owns owner points present provides recorded registered related relates relationship relationships reported represents represented sent shown shows shares sharing states stated stored supported tied uses used using value values
   activity address data detail details element elements entity entities evidence field fields group identifier identifiers information item items kind kinds link list name note notes part parts pattern record records reference references result results role set shape source sources status structure summary text thing things type types view
   active additional apparent available common complete consistent different direct directly established existing general indirect main masked missing neutral notable open overall particular possible potential separate similar specific standard typical unknown
   instead likely perhaps possibly probably rather therefore thus unclear
   city cities country countries region regions street streets postal code codes id ids titled title titles people person persons movement movements set sets listed list mention mentions mentioned describe description descriptions
   connection connections called refer refers referred reference following follows given give take takes taken get gets got use cannot become becomes becoming hence wherever whoever whatever
   side sides end ends start starts`
    .split(/\s+/)
    .filter((word) => word !== ''),
);
