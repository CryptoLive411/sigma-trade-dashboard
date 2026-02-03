import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { getToken } from "@/lib/api";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Trackers from "./pages/Trackers";
import Runtime from "./pages/Runtime";
import Trades from "./pages/Trades";
import Detections from "./pages/Detections";
import Tx from "./pages/Tx";
import Account from "./pages/Account";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = getToken();
  if (!token) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/trackers" element={<ProtectedRoute><Trackers /></ProtectedRoute>} />
          <Route path="/runtime" element={<ProtectedRoute><Runtime /></ProtectedRoute>} />
          <Route path="/trades" element={<ProtectedRoute><Trades /></ProtectedRoute>} />
          <Route path="/detections" element={<ProtectedRoute><Detections /></ProtectedRoute>} />
          <Route path="/tx" element={<ProtectedRoute><Tx /></ProtectedRoute>} />
          <Route path="/account" element={<ProtectedRoute><Account /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
