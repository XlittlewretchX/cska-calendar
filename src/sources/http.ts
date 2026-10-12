import { setTimeout as delay } from 'node:timers/promises';
export type GetText = (url: string) => Promise<string>;
export class HttpClient {
  private lastRequest = 0;
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly interval = 500,
  ) {}
  async get(url: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(Math.max(0, this.interval - (Date.now() - this.lastRequest)));
      this.lastRequest = Date.now();
      try {
        const response = await this.fetcher(url, {
          signal: AbortSignal.timeout(30_000),
          headers: {
            'User-Agent':
              'CSKA-Calendar/1.0 (+https://github.com/XlittlewretchX/cska-calendar)',
            Accept: 'application/json,text/html',
          },
        });
        if (!response.ok) {
          if (response.status !== 429 && response.status < 500)
            throw new PermanentHttpError(`${response.status} ${url}`);
          const retry = response.headers.get('retry-after');
          if (retry && /^\d+$/.test(retry))
            await delay(Math.min(Number(retry) * 1000, 30_000));
          throw new Error(`HTTP ${response.status} ${url}`);
        }
        const body = await response.text();
        if (body.length > 15_000_000)
          throw new PermanentHttpError(`Response too large: ${url}`);
        return body;
      } catch (error) {
        if (error instanceof PermanentHttpError || attempt === 2) throw error;
        console.warn(`Request retry ${attempt + 1}: ${url}: ${String(error)}`);
        await delay(1000 * 2 ** attempt);
      }
    }
    throw new Error('Unreachable');
  }
}
class PermanentHttpError extends Error {}
