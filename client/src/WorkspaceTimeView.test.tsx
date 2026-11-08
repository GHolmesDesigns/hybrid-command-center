import {
  fireEvent,
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  testState,
} from './App.test-setup';
import { WorkspaceTimeView } from './components/WorkspaceTimeView';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TimeEntry } from '../../shared/types';

function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output aria-label="Current query">{location.search}</output>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}

const entry: TimeEntry = {
  id: 'entry-1',
  projectId: 'project-1',
  projectName: 'Studio',
  taskId: 'task-1',
  taskTitle: 'Research',
  categoryId: 'category-1',
  categoryName: 'Design',
  startedAt: '2026-11-08T05:30:00.000Z',
  endedAt: '2026-11-08T06:30:00.000Z',
  durationSeconds: 3600,
  notes: 'Draft review',
  createdAt: '2026-11-08T06:30:00.000Z',
  updatedAt: '2026-11-08T06:30:00.000Z',
  revision: 1,
};

describe('Workspace time report', () => {
  it('keeps filters in browser history and restores the prior selection', async () => {
    testState.workspaceTimePayload.entries = [entry];
    render(
      <MemoryRouter initialEntries={['/time?from=2026-11-02&to=2026-11-08&project=project-1']}>
        <HistoryControls />
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    await screen.findByText('Draft review');
    expect(screen.getByLabelText('Project')).toHaveValue('project-1');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'category-1' } });
    expect(await screen.findByLabelText('Current query')).toHaveTextContent('category=category-1');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen
      .findByLabelText('Current query')
      .then((query) => expect(query).not.toHaveTextContent('category=category-1'));
    expect(screen.getByLabelText('Category')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(await screen.findByLabelText('Category')).toHaveValue('category-1');
  });

  it('shows an empty state without a zero total when no entries match', async () => {
    render(
      <MemoryRouter initialEntries={['/time?from=2026-12-01&to=2026-12-07']}>
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No matching time')).toBeVisible();
    expect(screen.getByText('No entries in this range')).toBeVisible();
  });
});
