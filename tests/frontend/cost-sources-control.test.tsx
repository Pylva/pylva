import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CostSourceTrackingStatus, CostSourceType, type PricingTier } from '@pylva/shared';
import {
  CostSourcesControlTable,
  type CostSourceControlRow,
} from '@/components/cost-sources/CostSourcesControlTable';
import { PricingConfigForm } from '@/components/cost-sources/PricingConfigForm';

function row(overrides: Partial<CostSourceControlRow>): CostSourceControlRow {
  return {
    id: overrides.id ?? 'row-1',
    source_type: overrides.source_type ?? CostSourceType.NON_LLM_MANUAL,
    display_name: overrides.display_name ?? 'Tavily Search',
    slug: overrides.slug ?? 'tavily-search',
    metric: overrides.metric ?? null,
    unit: overrides.unit ?? null,
    status: overrides.status ?? 'healthy',
    tracking_status: overrides.tracking_status ?? CostSourceTrackingStatus.PENDING,
    matchers: overrides.matchers ?? ['tavily-search'],
    last_seen_at: overrides.last_seen_at ?? null,
    last_discovered_at: overrides.last_discovered_at ?? '2026-07-08T00:00:00.000Z',
    discovery_count: overrides.discovery_count ?? 1,
    has_pricing: overrides.has_pricing ?? false,
  };
}

const rows: CostSourceControlRow[] = [
  row({
    id: 'llm-openai',
    source_type: CostSourceType.LLM_PROVIDER,
    display_name: 'OpenAI',
    slug: 'openai',
    tracking_status: CostSourceTrackingStatus.TRACKED,
    metric: null,
    unit: null,
    last_seen_at: '2026-07-08T00:00:00.000Z',
    last_discovered_at: null,
    discovery_count: 0,
    has_pricing: true,
  }),
  row({
    id: 'pending-tavily',
    display_name: 'Tavily Search',
    slug: 'tavily-search',
    tracking_status: CostSourceTrackingStatus.PENDING,
  }),
  row({
    id: 'tracked-elevenlabs',
    display_name: 'ElevenLabs',
    slug: 'elevenlabs',
    tracking_status: CostSourceTrackingStatus.TRACKED,
    metric: 'elevenlabs_characters',
    unit: 'character',
    has_pricing: true,
  }),
  row({
    id: 'ignored-grep',
    display_name: 'Grep',
    slug: 'grep',
    tracking_status: CostSourceTrackingStatus.IGNORED,
    has_pricing: false,
  }),
];

describe('<CostSourcesControlTable>', () => {
  it('filters rows by tracking state and LLM providers', () => {
    render(<CostSourcesControlTable slug="acme" sources={rows} canMutate />);

    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Tavily Search')).toBeInTheDocument();
    expect(screen.getByText('ElevenLabs')).toBeInTheDocument();
    expect(screen.getByText('Grep')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
    expect(screen.getByText('Tavily Search')).toBeInTheDocument();
    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument();
    expect(screen.queryByText('Grep')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'LLM providers' }));
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('Tavily Search')).not.toBeInTheDocument();
  });

  it('lets owners ignore non-LLM sources and hides mutation controls from members', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ cost_source: { slug: 'tavily-search' } }), { status: 200 }),
      );
    const { rerender } = render(<CostSourcesControlTable slug="acme" sources={rows} canMutate />);

    const ignoreButtons = screen.getAllByRole('button', { name: 'Ignore' });
    fireEvent.click(ignoreButtons[0]!);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/v1/cost-sources?slug=tavily-search',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ tracking_status: CostSourceTrackingStatus.IGNORED }),
        }),
      ),
    );
    await waitFor(() => expect(screen.getAllByText('Ignored').length).toBeGreaterThanOrEqual(2));

    rerender(<CostSourcesControlTable slug="acme" sources={rows} canMutate={false} />);
    expect(screen.queryByRole('button', { name: 'Ignore' })).not.toBeInTheDocument();
  });
});

describe('<PricingConfigForm>', () => {
  it('blocks activation until metric, unit, matcher, and price are configured', async () => {
    render(
      <PricingConfigForm
        slug="tavily-search"
        sourceType={CostSourceType.NON_LLM_MANUAL}
        displayName="Tavily Search"
        metric={null}
        unit={null}
        trackingStatus={CostSourceTrackingStatus.PENDING}
        matchers={[]}
        defaultMetricValue={1}
        initialPricePerUnit={null}
        initialTiers={null as PricingTier[] | null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Track source' }));

    expect(
      await screen.findByText('Metric is required before tracking this source.'),
    ).toBeInTheDocument();
  });
});
