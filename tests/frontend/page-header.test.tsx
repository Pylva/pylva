import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader, DashboardCard } from '@/components/dashboard/PageHeader';

describe('<PageHeader>', () => {
  it('renders exactly one h1 with the supplied title', () => {
    render(<PageHeader title="Overview" />);
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Overview');
  });

  it('renders the description paragraph when description is supplied', () => {
    render(<PageHeader title="Models" description="Per-provider costs" />);
    expect(screen.getByText('Per-provider costs')).toBeInTheDocument();
  });

  it('omits the description paragraph when description is absent', () => {
    const { container } = render(<PageHeader title="Models" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders the action slot when supplied and omits it when absent', () => {
    const { rerender, container } = render(
      <PageHeader title="Rules" action={<button type="button">New rule</button>} />,
    );
    expect(screen.getByRole('button', { name: 'New rule' })).toBeInTheDocument();
    // shrink-0 wrapper present when action exists
    expect(container.querySelector('.shrink-0')).not.toBeNull();

    rerender(<PageHeader title="Rules" />);
    expect(container.querySelector('.shrink-0')).toBeNull();
  });
});

describe('<DashboardCard>', () => {
  it('wraps children in .app-card and merges extra className', () => {
    const { container } = render(
      <DashboardCard className="p-4 bonus">
        <span>hello</span>
      </DashboardCard>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('app-card');
    expect(root.className).toContain('p-4');
    expect(root.className).toContain('bonus');
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});
