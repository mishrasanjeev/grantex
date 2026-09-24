import { Suspense, useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { ToastContainer } from '../ui/Toast';
import { Spinner } from '../ui/Spinner';

export function Shell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="min-h-screen bg-gx-bg">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="lg:ml-56">
        <TopBar onMenuClick={() => setSidebarOpen(true)} />
        <main className="p-6">
          <Suspense fallback={<div className="flex min-h-40 items-center justify-center"><Spinner className="h-8 w-8" /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
