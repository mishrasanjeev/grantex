import { Suspense } from 'react';
import { useRoutes } from 'react-router-dom';
import { routes } from './routes';
import { Spinner } from './components/ui/Spinner';

export function App() {
  const element = useRoutes(routes);
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Spinner className="h-8 w-8" /></div>}>
      {element}
    </Suspense>
  );
}
