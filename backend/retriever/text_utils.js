/**
 * text_utils.js — tokenisation shared by retrieval and citation grounding.
 *
 * Lifted out of the (removed) extraction pipeline's regex_utils.js: the corpus
 * in this demo is pre-indexed, but BM25 scoring and citation repair still have
 * to tokenise query and chunk text the same way the indexer did, so the token
 * rule and stopword list must stay byte-identical to what produced the index.
 */

export const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','as','is','was','are','were','be','been','being','have',
  'has','had','do','does','did','will','would','could','should','may',
  'might','this','that','these','those','it','its','i','we','you','he',
  'she','they','their','our','us','not','no','so','if','than','then',
]);

export function tokenise(text) {
  const tokens = (text.toLowerCase().match(/[a-z]+/g) || []);
  return tokens.filter((token) => !STOPWORDS.has(token) && token.length > 2);
}
