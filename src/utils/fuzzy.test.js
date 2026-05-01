import { describe, it, expect } from 'vitest';
import { normalizeTitle, tokens, similarity, findMatches, classify, MATCH_CONFIDENT, MATCH_AMBIGUOUS } from './fuzzy';

describe('normalizeTitle', () => {
  it('preserves nothing fancy — lowercase ASCII only', () => {
    expect(normalizeTitle('Harry Potter & the Sorcerer\u2019s Stone'))
      .toBe('harry potter the sorcerer s stone');
  });

  it('strips diacritics for compare', () => {
    expect(normalizeTitle('El Niño y la Cigüeña')).toBe('el nino y la ciguena');
  });

  it('keeps non-latin scripts (CJK) and decomposes only combining marks', () => {
    // NFKD decomposes 'й' → 'и' + combining breve, which we strip
    // (standard fuzzy-match behavior, same idea as é→e).
    expect(normalizeTitle('Война и мир')).toBe('воина и мир');
    expect(normalizeTitle('源氏物語')).toBe('源氏物語');
  });

  it('handles empty/null', () => {
    expect(normalizeTitle('')).toBe('');
    expect(normalizeTitle(null)).toBe('');
  });
});

describe('tokens', () => {
  it('drops English stopwords', () => {
    expect(tokens('The Catcher in the Rye')).toEqual(['catcher', 'rye']);
  });
});

describe('similarity', () => {
  it('returns 1 for identical', () => {
    expect(similarity('Dune', 'Dune')).toBe(1);
  });

  it('high score for accent-only difference', () => {
    expect(similarity('Cien Años de Soledad', 'Cien Anos de Soledad')).toBeGreaterThanOrEqual(0.95);
  });

  it('high score for case + punctuation differences', () => {
    expect(similarity('THE GREAT GATSBY!', 'The Great Gatsby')).toBeGreaterThanOrEqual(0.9);
  });

  it('handles single-word OCR slips', () => {
    expect(similarity('To Kill a Mockingbird', 'To Kil a Mockingbird')).toBeGreaterThanOrEqual(0.85);
  });

  it('low score for unrelated titles', () => {
    expect(similarity('Dune', 'The Hobbit')).toBeLessThan(0.4);
  });

  it('matches subtitle/edition variants reasonably', () => {
    // Token-set should boost reorderings/extra words
    expect(similarity('Sapiens: A Brief History of Humankind', 'Sapiens'))
      .toBeGreaterThanOrEqual(0.5);
  });

  it('returns 0 for empty inputs', () => {
    expect(similarity('', 'foo')).toBe(0);
    expect(similarity('foo', '')).toBe(0);
  });
});

describe('findMatches', () => {
  const index = [
    { isbn: '9780747532699', po: 'PO-1', title: "Harry Potter and the Philosopher's Stone" },
    { isbn: '9780439064873', po: 'PO-1', title: 'Harry Potter and the Chamber of Secrets' },
    { isbn: '9780743273565', po: 'PO-2', title: 'The Great Gatsby' },
    { isbn: '9780060883287', po: 'PO-3', title: 'One Hundred Years of Solitude' },
  ];

  it('finds exact match with score 1', () => {
    const r = findMatches('The Great Gatsby', index);
    expect(r[0].isbn).toBe('9780743273565');
    expect(r[0].score).toBe(1);
  });

  it('top match wins ambiguity', () => {
    const r = findMatches('Harry Potter and the Chamber', index);
    expect(r[0].isbn).toBe('9780439064873');
    expect(r[0].score).toBeGreaterThan(r[1].score);
  });

  it('returns up to topK', () => {
    const r = findMatches('harry potter', index, { topK: 2 });
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('respects minScore filter', () => {
    const r = findMatches('Completely Unrelated Book Title', index, { minScore: 0.7 });
    expect(r).toEqual([]);
  });
});

describe('classify', () => {
  it('confident at >= 0.85', () => {
    expect(classify(0.9)).toBe('confident');
    expect(classify(MATCH_CONFIDENT)).toBe('confident');
  });
  it('ambiguous in [0.70, 0.85)', () => {
    expect(classify(0.75)).toBe('ambiguous');
    expect(classify(MATCH_AMBIGUOUS)).toBe('ambiguous');
  });
  it('none below 0.70', () => {
    expect(classify(0.5)).toBe('none');
  });
});
