import { <%= className %>Impl } from './<%= className %>Impl.js';

export * from '../generated/api/index.js';
export * from '../generated/model/index.js';

export function new<%= className %>() {
  return new <%= className %>Impl();
}
