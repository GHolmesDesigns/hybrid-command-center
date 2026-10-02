/**
 * A refusal from account approval or client mapping. It carries its own HTTP status and a message
 * written for the person who pressed the button: never a provider body, a token, or a SQL error.
 */
export class AdsAccountError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AdsAccountError';
    this.status = status;
  }
}
