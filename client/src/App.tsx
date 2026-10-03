import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Toast } from './components/common';
import { registerServiceWorker } from './lib/push';
import { CallOverlay } from './screens/Calls';
import { ChatScreen } from './screens/Chat';
import { Home } from './screens/Home';
import { Login, Register, VerifyOtp } from './screens/Auth';
import { NewChat, UserProfile } from './screens/People';
import { MyProfile, Settings } from './screens/Settings';
import { StatusComposer, StatusViewer } from './screens/Status';
import { useSession } from './store/session';

export function App() {
  const status = useSession((s) => s.status);
  const nav = useNavigate();

  useEffect(() => {
    void useSession.getState().init();
    void registerServiceWorker()?.catch(() => undefined);
    // Notification clicks from the service worker deep-link into the app.
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.url === 'string') nav(e.data.url);
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [nav]);

  if (status === 'loading') return <div className="empty-main">Loading…</div>;

  if (status === 'anon') {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/verify" element={<VerifyOtp />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <Toast />
      </>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/status/new" element={<FullPage><StatusComposer /></FullPage>} />
        <Route path="/status/view/:userId" element={<StatusViewer />} />
        <Route element={<Home />}>
          <Route path="/" element={null} />
          <Route path="/status" element={null} />
          <Route path="/calls" element={null} />
          <Route path="/chat/:id" element={<ChatScreen />} />
          <Route path="/new" element={<NewChat />} />
          <Route path="/user/:id" element={<UserProfile />} />
          <Route path="/profile" element={<MyProfile />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="/verify" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CallOverlay />
      <Toast />
    </>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return <div className="main" style={{ height: '100%' }}>{children}</div>;
}
