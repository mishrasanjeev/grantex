import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { ToastContainer } from '../ui/Toast';

export function Shell() {
  return (
    <div className="min-h-screen bg-gx-bg">
      <Sidebar />
      <div className="ml-56">
        <TopBar />
        <main className="p-6">
          <Outlet />
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
