/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { AdminPage } from './pages/AdminPage';
import { SettingsPage } from './pages/SettingsPage';
import { Header } from './layout/Header';
import { Footer } from './layout/Footer';
import { ProjectSearchView } from './components/marketplace/ProjectSearchView';
import type { UserAccount, Order, Gig, Project, Proposal } from './types';
import { getAuthToken } from './utils/authToken';
import { slugify } from './utils/slugify';

export interface AppProps {
  initialPath?: string;
  initialData?: any;
}

export default function App({ initialPath, initialData }: AppProps) {
  const [currentPath, setCurrentPath] = useState<string>(() => {
    if (initialPath) return initialPath;
    if (typeof window !== 'undefined') return window.location.pathname;
    return '/';
  });

  const [currentUser, setCurrentUser] = useState<UserAccount | null>(initialData?.currentUser || null);
  const [impersonatedUser, setImpersonatedUser] = useState<UserAccount | null>(null);
  const [orders, setOrders] = useState<Order[]>(initialData?.orders || []);
  const [gigs, setGigs] = useState<Gig[]>(initialData?.gigs || []);
  const [projects, setProjects] = useState<Project[]>(initialData?.projects || []);
  const [proposals, setProposals] = useState<Proposal[]>(initialData?.proposals || []);
  const [likedGigIds, setLikedGigIds] = useState<string[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const navigate = (to: string, e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', to);
      setCurrentPath(to);
      window.scrollTo(0, 0);
    }
  };

  useEffect(() => {
    const handlePopState = () => {
      if (typeof window !== 'undefined') {
        setCurrentPath(window.location.pathname);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const loadUserSession = async (): Promise<boolean> => {
    try {
      const token = getAuthToken();
      if (!token) return false;
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          setCurrentUser(data.user);
          return true;
        }
      }
    } catch {}
    return false;
  };

  useEffect(() => {
    loadUserSession();
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [gigsRes, projectsRes] = await Promise.all([
        fetch('/api/gigs').catch(() => null),
        fetch('/api/projects').catch(() => null)
      ]);
      if (gigsRes && gigsRes.ok) {
        const gData = await gigsRes.json();
        if (Array.isArray(gData)) setGigs(gData);
      }
      if (projectsRes && projectsRes.ok) {
        const pData = await projectsRes.json();
        if (Array.isArray(pData)) setProjects(pData);
      }
    } catch {}
  };

  const isGigsList = currentPath === '/gigs' || currentPath.startsWith('/categories');
  const isGigDetail = currentPath.startsWith('/gig/') || (currentPath.split('/').filter(Boolean).length === 2 && !['admin', 'settings', 'projects', 'freelancers'].includes(currentPath.split('/')[1]));
  const isProjectsList = ['/projects', '/search-projects', '/project-search', '/freelance-jobs'].includes(currentPath);
  const isProjectDetail = currentPath.startsWith('/projects/');
  const isCategoryRoute = currentPath.startsWith('/categories/');

  // Render view based on route
  const renderContent = () => {
    if (currentPath.startsWith('/admin')) {
      return (
        <AdminPage
          currentUser={currentUser}
          impersonatedUser={impersonatedUser}
          updateCurrentUser={setCurrentUser}
          setImpersonatedUser={setImpersonatedUser}
          usersList={[]}
          setUsersList={() => {}}
          projects={projects}
          gigs={gigs}
          orders={orders}
          proposals={proposals}
          navigate={navigate}
          refresh={fetchData}
        />
      );
    }

    if (currentPath.startsWith('/settings')) {
      return (
        <SettingsPage
          currentUser={currentUser}
          updateCurrentUser={setCurrentUser}
          navigate={navigate}
        />
      );
    }

    if (isProjectsList || isProjectDetail) {
      return (
        <div className="max-w-7xl mx-auto px-4 py-8">
          <ProjectSearchView projects={projects} navigate={navigate} currentUser={currentUser} />
        </div>
      );
    }

    // Default Marketplace / Home view
    const filteredGigs = gigs.filter(g => 
      !searchQuery || 
      g.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
      g.description?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
      <div className="max-w-7xl mx-auto px-4 py-10 space-y-12">
        {/* Hero Section */}
        <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-emerald-950 rounded-3xl p-8 md:p-14 text-white shadow-xl relative overflow-hidden">
          <div className="relative z-10 max-w-2xl space-y-6">
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-semibold tracking-wide uppercase">
              Secure Escrow Marketplace
            </span>
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight leading-tight">
              Find expert freelancers for any project, guaranteed.
            </h1>
            <p className="text-slate-300 text-base md:text-lg leading-relaxed">
              WorkPerHour connects businesses with top-tier freelance professionals. 100% escrow protection and milestone billing.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <div className="relative flex-grow">
                <input
                  type="text"
                  placeholder="What service are you looking for today?"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white/10 border border-white/20 rounded-2xl px-5 py-4 text-white placeholder-slate-400 focus:outline-none focus:border-emerald-400 text-sm backdrop-blur-md"
                />
              </div>
              <button
                onClick={() => navigate('/gigs')}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-8 py-4 rounded-2xl transition-all shadow-lg flex items-center justify-center gap-2 text-sm"
              >
                <span>Explore Gigs</span>
              </button>
            </div>
          </div>
        </div>

        {/* Gigs Grid */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Popular Professional Services</h2>
            <button onClick={() => navigate('/projects')} className="text-sm font-semibold text-emerald-600 hover:underline">
              Browse Projects →
            </button>
          </div>

          {filteredGigs.length === 0 ? (
            <div className="text-center py-20 bg-white rounded-3xl border border-slate-200/80 shadow-sm">
              <p className="text-slate-500 text-sm">No gigs found. Try adjusting your search query.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredGigs.map((gig) => {
                const uname = (gig.freelancerUsername || slugify(gig.freelancerName || 'freelancer')).toLowerCase();
                const gslug = (gig.slug || slugify(gig.title)).toLowerCase();
                const gigUrl = `/${uname}/${gslug}`;
                return (
                  <div
                    key={gig.id}
                    onClick={(e) => navigate(gigUrl, e)}
                    className="bg-white rounded-3xl border border-slate-200/80 overflow-hidden shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col group"
                  >
                    <div className="h-48 bg-slate-100 overflow-hidden relative">
                      <img
                        src={gig.image || gig.coverImage || 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=600&auto=format&fit=crop&q=80'}
                        alt={gig.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    </div>
                    <div className="p-6 flex-grow flex flex-col justify-between space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
                          <span>{gig.freelancerName || 'Freelancer'}</span>
                          <span>•</span>
                          <span className="text-amber-500 font-bold">★ {gig.rating || '5.0'} ({gig.reviewsCount || 0})</span>
                        </div>
                        <h3 className="font-bold text-slate-900 text-base line-clamp-2 group-hover:text-emerald-600 transition-colors">
                          {gig.title}
                        </h3>
                      </div>
                      <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Starting at</span>
                        <span className="text-lg font-extrabold text-slate-900">${gig.price ?? 100}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800">
      {!currentPath.startsWith('/admin') && (
        <Header
          navigate={navigate}
          currentUser={currentUser}
          orders={orders}
          likedGigIds={likedGigIds}
          isGigsList={isGigsList}
          isGigDetail={isGigDetail}
          isProjectsList={isProjectsList}
          isProjectDetail={isProjectDetail}
          isCategoryRoute={isCategoryRoute}
          loadUserSession={loadUserSession}
          updateCurrentUser={setCurrentUser}
          setImpersonatedUser={setImpersonatedUser}
          setSelectedOrder={setSelectedOrder}
          setPath={setCurrentPath}
          fetchMessages={() => {}}
        />
      )}

      <main className="flex-grow">
        {renderContent()}
      </main>

      {!currentPath.startsWith('/admin') && <Footer navigate={navigate} />}
    </div>
  );
}
