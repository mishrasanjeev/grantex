import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table } from '../ui/Table';

interface TestRow {
  id: string;
  name: string;
  email: string;
}

const sampleData: TestRow[] = [
  { id: '1', name: 'Alice', email: 'alice@example.com' },
  { id: '2', name: 'Bob', email: 'bob@example.com' },
  { id: '3', name: 'Charlie', email: 'charlie@example.com' },
];

const columns = [
  { key: 'name', header: 'Name', render: (row: TestRow) => row.name },
  { key: 'email', header: 'Email', render: (row: TestRow) => row.email },
];

describe('Table', () => {
  it('renders column headers', () => {
    render(<Table columns={columns} data={sampleData} rowKey={(r) => r.id} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('renders all data rows', () => {
    render(<Table columns={columns} data={sampleData} rowKey={(r) => r.id} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });

  it('renders cell values using column render functions', () => {
    render(<Table columns={columns} data={sampleData} rowKey={(r) => r.id} />);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('calls onRowClick when a row is clicked', async () => {
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Table columns={columns} data={sampleData} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    await user.click(screen.getByText('Alice'));
    expect(onRowClick).toHaveBeenCalledWith(sampleData[0]);
  });

  it('applies cursor-pointer class when onRowClick is provided', () => {
    const onRowClick = vi.fn();
    render(
      <Table columns={columns} data={sampleData} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    const row = screen.getByText('Alice').closest('tr');
    expect(row).toHaveClass('cursor-pointer');
  });

  it('does not apply cursor-pointer class when onRowClick is absent', () => {
    render(<Table columns={columns} data={sampleData} rowKey={(r) => r.id} />);
    const row = screen.getByText('Alice').closest('tr');
    expect(row).not.toHaveClass('cursor-pointer');
  });

  it('renders an empty table when data is empty', () => {
    render(<Table columns={columns} data={[]} rowKey={(r: TestRow) => r.id} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    // No data rows
    const rows = screen.queryAllByRole('row');
    // Only header row
    expect(rows).toHaveLength(1);
  });

  it('uses custom render functions for complex cell content', () => {
    const customColumns = [
      {
        key: 'name',
        header: 'Name',
        render: (row: TestRow) => <strong data-testid="strong-name">{row.name}</strong>,
      },
    ];
    render(<Table columns={customColumns} data={[sampleData[0]!]} rowKey={(r) => r.id} />);
    expect(screen.getByTestId('strong-name')).toHaveTextContent('Alice');
  });

  it('applies column className to header and cells', () => {
    const colsWithClass = [
      { key: 'name', header: 'Name', render: (row: TestRow) => row.name, className: 'w-1/2' },
    ];
    render(<Table columns={colsWithClass} data={[sampleData[0]!]} rowKey={(r) => r.id} />);
    const th = screen.getByText('Name');
    expect(th).toHaveClass('w-1/2');
  });
});
