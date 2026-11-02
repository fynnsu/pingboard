export function addTimelineFixture(fixture) {
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  for (const [index, item] of fixture.items.entries()) {
    const age = 8 + (fixture.items.length - index) * 5;
    item.createdAt = ago(age);
    item.timeline = [
      { __typename: "ReadyForReviewEvent", id: `${item.id}-ready`, createdAt: ago(age - 3), actor: item.author },
      { __typename: "ReviewRequestedEvent", id: `${item.id}-requested`, createdAt: ago(age - 6), actor: item.author },
      { __typename: "PullRequestReview", id: `${item.id}-review`, submittedAt: ago(age - 8), author: { login: "maintainer" }, state: "CHANGES_REQUESTED", bodyText: "Please add a regression test for the empty queue.", url: item.url },
      { __typename: "PullRequestCommit", id: `${item.id}-commit`, commit: { committedDate: ago(age - 9), messageHeadline: "Cover the empty queue regression", url: item.url, author: { user: item.author } } },
      { __typename: "IssueComment", id: `${item.id}-reply`, createdAt: ago(age - 9.2), author: item.author, bodyText: "Added coverage and updated the implementation. Ready for another look.", url: item.url },
      { __typename: "PullRequestReview", id: `${item.id}-approved`, submittedAt: ago(2 + index / 10), author: { login: "maintainer" }, state: "APPROVED", bodyText: "Looks good!", url: item.url }
    ];
  }
  const merged = fixture.makeItem(101, { title: "Fix cache invalidation during rolling upgrades", createdAt: ago(65), updatedAt: ago(25), state: "MERGED", mergedAt: ago(25), closedAt: ago(25), mergedBy: { login: "maintainer" }, timeline: [
    { __typename: "PullRequestReview", id: "merged-review", submittedAt: ago(28), author: { login: "maintainer" }, state: "APPROVED", bodyText: "Verified against a rolling deployment." },
    { __typename: "MergedEvent", id: "merged-event", createdAt: ago(25), actor: { login: "maintainer" } }
  ] });
  const closed = fixture.makeItem(102, { title: "Explore an alternative scheduler design", createdAt: ago(80), updatedAt: ago(40), state: "CLOSED", closedAt: ago(40), timeline: [
    { __typename: "ClosedEvent", id: "first-close", createdAt: ago(70), actor: { login: "maintainer" } },
    { __typename: "ReopenedEvent", id: "reopen", createdAt: ago(60), actor: { login: "maintainer" } },
    { __typename: "IssueComment", id: "closed-reply", createdAt: ago(41), author: { login: "sam" }, bodyText: "We incorporated the useful parts into the other implementation." },
    { __typename: "ClosedEvent", id: "final-close", createdAt: ago(40), actor: { login: "maintainer" } }
  ] });
  fixture.items.push(merged, closed);
  return { ago, merged, closed };
}
