import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, SkeletonCard, SkeletonTable, PageSkeleton } from '../ui/Skeleton';

describe('Skeleton', () => {
  it('renders with animate-pulse class', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveClass('animate-pulse');
  });

  it('applies custom className', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    expect(container.firstChild).toHaveClass('h-4');
  });
});

describe('SkeletonCard', () => {
  it('renders', () => {
    const { container } = render(<SkeletonCard />);
    expect(container.firstChild).toBeInTheDocument();
  });
});

describe('SkeletonTable', () => {
  it('renders default 5 rows', () => {
    const { container } = render(<SkeletonTable />);
    const rows = container.querySelectorAll('.border-b.border-gx-border\\/50');
    expect(rows.length).toBe(5);
  });

  it('renders custom row count', () => {
    const { container } = render(<SkeletonTable rows={3} />);
    const rows = container.querySelectorAll('.border-b.border-gx-border\\/50');
    expect(rows.length).toBe(3);
  });
});

describe('PageSkeleton', () => {
  it('renders without crashing', () => {
    const { container } = render(<PageSkeleton />);
    expect(container.firstChild).toBeInTheDocument();
  });
});
