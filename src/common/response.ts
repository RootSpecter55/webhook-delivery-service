import type { Response } from 'express';
import type { Page } from './pagination';

/** Success envelope: { data }. */
export function sendData(res: Response, data: unknown, status = 200) {
  res.status(status).json({ data });
}

/** List envelope: { data: [...], meta: { page, pageSize, total, totalPages } }. */
export function sendPage<T>(res: Response, page: Page<T>) {
  res.status(200).json({ data: page.items, meta: page.meta });
}
