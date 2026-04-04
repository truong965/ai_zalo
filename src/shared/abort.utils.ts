export class AbortUtils {
  static async withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      const err = new Error('AI Request Cancelled');
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    
    let abortListener: () => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => {
        const err = new Error('AI Request Cancelled');
        err.name = 'AbortError';
        reject(err);
      };
      signal.addEventListener('abort', abortListener);
    });

    try {
      return await Promise.race([promise, abortPromise]);
    } finally {
      if (abortListener!) signal.removeEventListener('abort', abortListener);
    }
  }

  static async *abortableStream<T>(
    stream: AsyncGenerator<T, any, unknown> | AsyncIterable<T>,
    signal?: AbortSignal
  ): AsyncGenerator<T, any, unknown> {
    if (!signal) {
      yield* stream;
      return;
    }

    if (signal.aborted) {
      const err = new Error('AI Request Cancelled');
      err.name = 'AbortError';
      throw err;
    }

    let abortListener: () => void;
    let isAborted = false;
    const abortError = new Error('AI Request Cancelled');
    abortError.name = 'AbortError';

    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => {
        isAborted = true;
        reject(abortError);
      };
      signal.addEventListener('abort', abortListener);
    });

    try {
      const iterator = "next" in stream ? stream : stream[Symbol.asyncIterator]();
      while (true) {
        if (isAborted) throw abortError;
        const result = await Promise.race([
          typeof iterator.next === 'function' ? iterator.next() : (iterator as any).next(), 
          abortPromise
        ]);
        if (result.done) return result.value;
        yield result.value;
      }
    } finally {
      if (abortListener!) signal.removeEventListener('abort', abortListener);
    }
  }

  static isAbortError(err: any): boolean {
    if (!err) return false;
    return (
      err.name === 'AbortError' || 
      err.message?.includes('aborted') || 
      err.message?.includes('AI Request Cancelled') ||
      err.code === 'ABORT_ERR'
    );
  }
}
