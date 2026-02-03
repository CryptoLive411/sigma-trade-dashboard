import { Link, useLocation } from 'react-router-dom';
import { clearToken } from '@/lib/api';
import { 
  Settings, 
  BarChart3, 
  ExternalLink, 
  LayoutGrid, 
  User, 
  Eye,
  Activity,
  LogOut
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiStatusIndicator } from './ApiStatusIndicator';
interface LayoutProps {
  children: React.ReactNode;
  title?: string;
}

export function Layout({ children, title }: LayoutProps) {
  const location = useLocation();
  
  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: Activity },
    { href: '/trackers', label: 'Trackers', icon: LayoutGrid },
    { href: '/runtime', label: 'Runtime', icon: Settings },
    { href: '/trades', label: 'Trades', icon: BarChart3 },
    { href: '/detections', label: 'Detections', icon: Eye },
    { href: '/tx', label: 'Tx', icon: ExternalLink },
    { href: '/account', label: 'Account', icon: User },
  ];

  const handleLogout = () => {
    clearToken();
    window.location.href = '/';
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background/70 backdrop-blur-md border-b border-border">
        <div className="container flex items-center justify-between py-3">
          <div className="flex items-center gap-4">
            <Link className="text-lg font-bold text-foreground" to="/dashboard">
              Base Sniper
            </Link>
            <nav className="hidden sm:flex items-center gap-3">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className={cn(
                      "inline-flex items-center gap-1 text-sm transition-colors",
                      isActive 
                        ? "text-primary font-medium" 
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <ApiStatusIndicator />
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Logout
            </button>
          </div>
        </div>
      </header>
      <main className="container pt-6 pb-12">
        {title && (
          <div className="bg-card border border-border rounded-xl p-4 mb-4">
            <h2 className="m-0 text-xl font-semibold">{title}</h2>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
