export interface CountableMember {
  confirmedAt?: string;
}

export type MemberPageReader = (options: {
  page: number;
  perPage: number;
}) => Promise<CountableMember[]>;

/** Paginate the complete Identity set and count confirmed accounts only. */
export async function countConfirmedMembers(
  readPage: MemberPageReader,
  pageSize = 100,
  maxPages = 1_000,
): Promise<number> {
  let count = 0;
  for (let page = 1; page <= maxPages; page++) {
    const members = await readPage({ page, perPage: pageSize });
    count += members.filter((member) => Boolean(member.confirmedAt)).length;
    if (members.length < pageSize) return count;
  }
  throw new Error('Identity user pagination exceeded the safety limit.');
}
