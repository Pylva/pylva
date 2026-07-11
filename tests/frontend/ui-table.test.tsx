// Regression guard for the dashboard table padding bug: cells used to carry
// only vertical padding, so first/last column text sat flush against the
// app-card border. These tests pin the class contract of the shared table
// primitives (jsdom cannot compute Tailwind CSS — pixel-level checks live in
// tests/e2e/dashboard-tables.spec.ts).

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// A horizontal padding class MUST be present on every th/td.
const HORIZONTAL_PADDING_RE = /(^|\s)px-\d/;

function renderBasicTable(cellProps: { className?: string } = {}) {
  return render(
    <TableContainer>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>End-user</TableHead>
            <TableHead className="text-end">Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell {...cellProps}>pylva-cutover-1782093690217</TableCell>
            <TableCell className="text-end tabular-nums">$1,234.57</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>acme-corp</TableCell>
            <TableCell className="text-end tabular-nums">$0.02</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TableContainer>,
  );
}

describe('Table primitives — padding contract', () => {
  it('every th and td carries a horizontal padding class by default', () => {
    renderBasicTable();
    const headers = screen.getAllByRole('columnheader');
    const cells = screen.getAllByRole('cell');
    expect(headers.length).toBeGreaterThan(0);
    expect(cells.length).toBeGreaterThan(0);
    for (const th of headers) {
      expect(th.className).toMatch(HORIZONTAL_PADDING_RE);
    }
    for (const td of cells) {
      expect(td.className).toMatch(HORIZONTAL_PADDING_RE);
    }
  });

  it('consumer className merges without dropping the horizontal padding', () => {
    renderBasicTable({ className: 'text-end font-medium' });
    const cell = screen.getByRole('cell', { name: 'pylva-cutover-1782093690217' });
    expect(cell.className).toMatch(HORIZONTAL_PADDING_RE);
    expect(cell).toHaveClass('text-end', 'font-medium');
  });

  it('density overrides replace vertical padding but keep horizontal padding', () => {
    renderBasicTable({ className: 'py-1' });
    const cell = screen.getByRole('cell', { name: 'pylva-cutover-1782093690217' });
    expect(cell).toHaveClass('py-1');
    expect(cell.className).not.toMatch(/(^|\s)py-3(\s|$)/);
    expect(cell.className).toMatch(HORIZONTAL_PADDING_RE);
  });

  it('numeric alignment helpers pass through (text-end + tabular-nums)', () => {
    renderBasicTable();
    const spend = screen.getAllByRole('cell', { name: /\$/ })[0]!;
    expect(spend).toHaveClass('text-end');
    expect(spend).toHaveClass('tabular-nums');
  });
});

describe('Table primitives — structure and semantics', () => {
  it('renders a real table inside the card overflow wrapper', () => {
    const { container } = renderBasicTable();
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    const wrapper = container.querySelector('.app-card.overflow-x-auto');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toContainElement(table);
    expect(screen.getAllByRole('rowgroup')).toHaveLength(2); // thead + tbody
  });

  it('header cells are start-aligned with accessible names; rows carry the divider border', () => {
    renderBasicTable();
    const head = screen.getByRole('columnheader', { name: 'End-user' });
    expect(head).toHaveClass('text-start');
    const rows = screen.getAllByRole('row');
    for (const tr of rows) {
      expect(tr.className).toMatch(/(^|\s)border-b(\s|$)/);
    }
  });

  it('the tbody removes the last-row border so it does not double the card edge', () => {
    const { container } = renderBasicTable();
    const tbody = container.querySelector('tbody');
    expect(tbody?.className).toContain('[&_tr:last-child]:border-0');
  });

  it('supports an sr-only label for action columns (axe empty-table-header guard)', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead className="text-end">
              <span className="sr-only">Simulate</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>gpt-4o</TableCell>
            <TableCell className="text-end">
              <a href="/simulate">What if?</a>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Simulate' })).toBeInTheDocument();
  });

  it('renders Arabic cell content intact (RTL data must not be mangled)', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>عميل-الشركة-السعودية</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('cell', { name: 'عميل-الشركة-السعودية' })).toBeInTheDocument();
  });

  it('keeps anchors inside link cells focusable', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>
              <a href="./end-users/acme" className="font-medium hover:underline">
                acme
              </a>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const link = screen.getByRole('link', { name: 'acme' });
    link.focus();
    expect(link).toHaveFocus();
  });
});
