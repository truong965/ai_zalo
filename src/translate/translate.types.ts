export interface TranslateResult {
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  skipped: boolean;
  engine: 'gemini' | 'ollama' | 'none';
  sessionId?: string;
  fromCache?: boolean;
}

export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslateError';
  }
}

export class ValidationError extends TranslateError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
