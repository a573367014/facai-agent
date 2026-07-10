/**
 * 文档切块器（Chunker）。
 *
 * 职责：把一段长文本切成若干个大小受控、带重叠窗口的 chunk，供后续 embedding 使用。
 *
 * 为什么需要切块（第一性原理）：
 * - Embedding 模型对输入长度有上限（通常几百到几千 token），整篇文档无法一次性向量化。
 * - 即使能塞进去，把整篇文档压成一个向量会"稀释"语义：一个向量要同时表示文档里所有话题，
 *   导致检索时无法精确定位到某一段。切块的本质是"让每个向量只负责一小段语义"，提升检索精度。
 *
 * 为什么切块之间要重叠（overlap）：
 * - 如果硬切，一个完整观点恰好被切成两半，检索时任何一半都不完整。
 * - 重叠窗口让相邻 chunk 共享一部分文本，保证"跨边界"的信息至少在一个 chunk 里是完整的。
 *
 * 边界：本模块只负责"纯文本 → chunk 数组"，不关心文本从哪来（PDF/Word/...），
 * 也不负责向量化或落库，是索引流水线中最纯粹的一环。
 */

/**
 * 一个切好的文本块，附带它在原文中的字符偏移区间。
 * startOffset / endOffset 用于在检索命中后回溯定位原文位置。
 */
export interface KnowledgeTextChunk {
  content: string;
  startOffset: number;
  endOffset: number;
}

/**
 * 切块参数。
 * - maxCharacters：单个 chunk 的字符上限（注意是字符不是 token，这是近似控制）。
 * - overlapCharacters：相邻 chunk 之间的重叠字符数。
 */
export interface SplitKnowledgeTextOptions {
  maxCharacters?: number;
  overlapCharacters?: number;
}

const DEFAULT_MAX_CHARACTERS = 800;
const DEFAULT_OVERLAP_CHARACTERS = 100;

/**
 * 把文本切分成带重叠的 chunk。
 *
 * 实现策略会根据文本是否含空格自动切换：
 * - 含空格（如英文、带空格的混排）→ 按单词边界切，避免把单词从中间劈开。
 * - 不含空格（如纯中文）→ 按字符切，因为没有"词边界"可利用。
 *
 * @param text 原始全文
 * @param options 切块参数，缺省时使用模块常量
 * @returns chunk 数组；空文本返回空数组
 */
export function splitKnowledgeText(text: string, options: SplitKnowledgeTextOptions = {}): KnowledgeTextChunk[] {
  const normalizedText = normalizeKnowledgeText(text);
  const maxCharacters = Math.max(1, Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS));
  // overlap 必须严格小于 maxCharacters，否则会出现"切完没前进"的死循环，这里用 min(..., maxCharacters - 1) 兜底
  const overlapCharacters = Math.max(0, Math.min(Math.floor(options.overlapCharacters ?? DEFAULT_OVERLAP_CHARACTERS), maxCharacters - 1));

  if (!normalizedText) {
    return [];
  }

  if (normalizedText.includes(" ")) {
    return splitByWords(normalizedText, maxCharacters, overlapCharacters);
  }

  return splitByCharacters(normalizedText, maxCharacters, overlapCharacters);
}

/**
 * 按固定字符数切块（适用于无空格分隔的文本，如纯中文）。
 * 每次窗口向前推进 (maxCharacters - overlapCharacters) 个字符，保证相邻 chunk 有重叠。
 */
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

/**
 * 按单词边界切块（适用于含空格的文本，如英文）。
 * 贪心地往当前 chunk 里塞单词，直到再加一个单词就会超过 maxCharacters 才开新 chunk。
 * 这样能保证每个 chunk 在单词边界处断开，不会出现半个单词。
 */
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

    // 单个单词本身就超长（比如一个超长 URL），单独切出来避免丢内容
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

    // 下一轮从"重叠区起始单词"开始，实现单词级重叠
    wordIndex = getOverlappedWordIndex(words, endWordIndex, overlapCharacters);
  }

  return chunks;
}

/**
 * 计算下一个 chunk 应该从哪个单词开始，以实现指定的字符级重叠。
 * 从当前 chunk 的末尾单词往前累计字符数，直到达到 overlapCharacters 上限。
 */
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

/**
 * 文本归一化：把所有连续空白（换行、制表符、多空格）压缩成单个空格。
 * 这样切块时只面对"单空格分隔"的文本，简化后续的边界判断逻辑。
 */
function normalizeKnowledgeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
