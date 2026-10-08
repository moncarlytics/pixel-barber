import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('writes a header row and rows, leaving missing values empty', () => {
    expect(
      toCsv(
        ['Barber', 'Served', 'Average rating'],
        [
          ['Kofi', 2, null],
          ['Ama', 0, 4.5],
        ],
      ),
    ).toBe('Barber,Served,Average rating\r\nKofi,2,\r\nAma,0,4.5\r\n');
  });

  it('quotes values with commas, quotes or line breaks', () => {
    expect(toCsv(['Reason'], [["Can't make it, sorry"], ['He said "no"'], ['two\nlines']])).toBe(
      'Reason\r\n"Can\'t make it, sorry"\r\n"He said ""no"""\r\n"two\nlines"\r\n',
    );
  });
});
