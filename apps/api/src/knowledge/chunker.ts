export interface KnowledgeTextChunk {
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface SplitKnowledgeTextOptions {
  maxCharacters?: number;
  overlapCharacters?: number;
}

const DEFAULT_MAX_CHARACTERS = 800;
const DEFAULT_OVERLAP_CHARACTERS = 100;

export function splitKnowledgeText(text: string, options: SplitKnowledgeTextOptions = {}): KnowledgeTextChunk[] {
  const normalizedText = normalizeKnowledgeText(text);
  const maxCharacters = Math.max(1, Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS));
  const overlapCharacters = Math.max(0, Math.min(Math.floor(options.overlapCharacters ?? DEFAULT_OVERLAP_CHARACTERS), maxCharacters - 1));

  if (!normalizedText) {
    return [];
  }

  if (normalizedText.includes(" ")) {
    return splitByWords(normalizedText, maxCharacters, overlapCharacters);
  }

  return splitByCharacters(normalizedText, maxCharacters, overlapCharacters);
}

function splitByCharacters(text: string, maxCharacters: number, overlapCharacters: number): KnowledgeTextChunk[] {
  const chunks: KnowledgeTextChunk[] = [];
  let startOffset = 0;

  while (startOffset < text.length) {
    const endOffset = Math.min(text.length, startOffset + maxCharacters);
    const content = text.slice(startOffset, endOffset).trim();

    if (content) {
      chunks.push({
        content,
        startOffset,
        endOffset
      });
    }

    if (endOffset === text.length) {
      break;
    }

    startOffset = endOffset - overlapCharacters;
  }

  return chunks;
}

function splitByWords(text: string, maxCharacters: number, overlapCharacters: number): KnowledgeTextChunk[] {
  const words = Array.from(text.matchAll(/\S+/g)).map((match) => ({
    value: match[0],
    startOffset: match.index ?? 0,
    endOffset: (match.index ?? 0) + match[0].length
  }));
  const chunks: KnowledgeTextChunk[] = [];
  let wordIndex = 0;

  while (wordIndex < words.length) {
    let endWordIndex = wordIndex;
    let content = "";

    while (endWordIndex < words.length) {
      const nextContent = content ? `${content} ${words[endWordIndex].value}` : words[endWordIndex].value;

      if (content && nextContent.length > maxCharacters) {
        break;
      }

      content = nextContent;
      endWordIndex += 1;

      if (content.length >= maxCharacters) {
        break;
      }
    }

    if (!content) {
      const word = words[wordIndex];
      chunks.push({
        content: word.value.slice(0, maxCharacters),
        startOffset: word.startOffset,
        endOffset: Math.min(word.endOffset, word.startOffset + maxCharacters)
      });
      wordIndex += 1;
      continue;
    }

    chunks.push({
      content,
      startOffset: words[wordIndex].startOffset,
      endOffset: words[endWordIndex - 1].endOffset
    });

    if (endWordIndex >= words.length) {
      break;
    }

    wordIndex = getOverlappedWordIndex(words, endWordIndex, overlapCharacters);
  }

  return chunks;
}

function getOverlappedWordIndex(
  words: Array<{ value: string; startOffset: number; endOffset: number }>,
  endWordIndex: number,
  overlapCharacters: number
) {
  if (overlapCharacters === 0) {
    return endWordIndex;
  }

  let overlappedCharacters = 0;
  let wordIndex = endWordIndex - 1;

  while (wordIndex > 0 && overlappedCharacters < overlapCharacters) {
    overlappedCharacters += words[wordIndex].value.length;
    wordIndex -= 1;
  }

  return Math.max(0, wordIndex + 1);
}

function normalizeKnowledgeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
