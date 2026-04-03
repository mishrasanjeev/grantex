import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../ui/Modal';

describe('Modal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders title and children when open is true', () => {
    render(
      <Modal open={true} onClose={vi.fn()} title="My Modal">
        <p>Modal body</p>
      </Modal>,
    );
    expect(screen.getByText('My Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal body')).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal open={true} onClose={onClose} title="Close Me">
        <p>Body</p>
      </Modal>,
    );
    // The close button contains the x character
    const closeBtn = screen.getByText('×');
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Escape">
        <p>Body</p>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal open={true} onClose={onClose} title="Overlay">
        <p>Body</p>
      </Modal>,
    );
    // The overlay is the outermost fixed div
    const overlay = screen.getByText('Overlay').closest('.fixed');
    if (overlay) {
      await user.click(overlay);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it('does not call onClose when modal content is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal open={true} onClose={onClose} title="No Close">
        <p>Click me</p>
      </Modal>,
    );
    await user.click(screen.getByText('Click me'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not listen for Escape when closed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={false} onClose={onClose} title="Closed">
        <p>Body</p>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders with overlay backdrop', () => {
    render(
      <Modal open={true} onClose={vi.fn()} title="Backdrop">
        <p>Body</p>
      </Modal>,
    );
    const overlay = screen.getByText('Backdrop').closest('.fixed');
    expect(overlay).toHaveClass('bg-black/60');
  });
});
