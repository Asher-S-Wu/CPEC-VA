export class VideoSourceError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "VideoSourceError";
    this.status = status;
  }
}
