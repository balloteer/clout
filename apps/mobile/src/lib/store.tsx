import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { api, API_URL } from './api'
import { allCatalogPosts, archivedPosts, samplePosts, type Post } from './data'
import { mapPost, type ApiPost } from './contracts'
import { mergePreviewFeed } from './catalog'
import { useWallet } from './wallet'
import { readPreferences, toggleItem, savedKey, type SamplePreferences } from './social'

type Store = {
  posts: Post[]
  liked: string[]
  saved: string[]
  following: string[]
  toggleLike: (id: string) => void
  toggleSave: (id: string) => void
  toggleFollow: (name: string) => void
  message: string
  notify: (message: string) => void
  refresh: () => Promise<void>
}
const Context = createContext<Store | null>(null)
const sampleKey = 'clout:preferences'
const sampleIds = new Set(allCatalogPosts.map((post) => post.id))
const sampleNames = new Set(allCatalogPosts.map((post) => post.creator))

export function AppStore({ children }: PropsWithChildren) {
  const wallet = useWallet()
  return <ScopedStore owner={wallet.address}>{children}</ScopedStore>
}

function ScopedStore({ children, owner }: PropsWithChildren<{ owner?: string }>) {
  const [posts, setPosts] = useState(samplePosts)
  const [samples, setSamples] = useState<SamplePreferences>({ liked: [], saved: [], following: [] })
  const [liveLiked, setLiveLiked] = useState<string[]>([])
  const [liveFollowing, setLiveFollowing] = useState<string[]>([])
  const [liveSaved, setLiveSaved] = useState<string[]>([])
  const [message, notify] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [scope, setScope] = useState(owner)
  const [feedOwner, setFeedOwner] = useState(owner)
  const active = useRef(true)
  const epoch = useRef(0)
  const pending = useRef(new Set<string>())
  const revision = useRef(0)
  const refreshGeneration = useRef(0)
  useEffect(() => {
    active.current = true
    const currentEpoch = ++epoch.current
    pending.current.clear()
    revision.current++
    refreshGeneration.current++
    void Promise.all([AsyncStorage.getItem(sampleKey), AsyncStorage.getItem(savedKey(owner))])
      .then(([sampleRaw, savedRaw]) => {
        if (!active.current || epoch.current !== currentEpoch) return
        const stored = readPreferences(sampleRaw)
        setScope(owner)
        setSamples({
          liked: stored.liked.filter((id) => sampleIds.has(id)),
          saved: stored.saved.filter((id) => sampleIds.has(id)),
          following: stored.following.filter((name) => sampleNames.has(name)),
        })
        setLiveSaved(readPreferences(savedRaw).saved.filter((id) => !sampleIds.has(id)))
      })
      .catch(() => {
        if (active.current && epoch.current === currentEpoch) {
          setScope(owner)
          setLiveSaved([])
          notify('Your saved preferences could not be loaded.')
        }
      })
      .finally(() => {
        if (active.current && epoch.current === currentEpoch) setLoaded(true)
      })
    return () => {
      active.current = false
      epoch.current = currentEpoch + 1
    }
  }, [owner])
  useEffect(() => {
    if (!loaded || scope !== owner) return
    void Promise.all([
      AsyncStorage.setItem(sampleKey, JSON.stringify(samples)),
      AsyncStorage.setItem(savedKey(owner), JSON.stringify({ saved: liveSaved })),
    ]).catch(() => {
      if (active.current) notify('Your changes could not be saved on this device.')
    })
  }, [samples, liveSaved, loaded, owner, scope])
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => notify(''), 4500)
    return () => clearTimeout(timer)
  }, [message])
  const refresh = useCallback(() => {
    if (!API_URL || pending.current.size) return Promise.resolve()
    const generation = ++refreshGeneration.current
    const currentRevision = revision.current
    const currentEpoch = epoch.current
    return api<{ posts: ApiPost[]; following: string[] }>('/v1/feed')
      .then((result) => {
        if (
          !active.current ||
          epoch.current !== currentEpoch ||
          generation !== refreshGeneration.current ||
          revision.current !== currentRevision
        )
          return
        const archivedIds = new Set(archivedPosts.map((post) => post.id))
        setPosts(
          mergePreviewFeed(
            samplePosts,
            result.posts.filter((post) => !archivedIds.has(post.id)).map(mapPost),
          ),
        )
        setFeedOwner(owner)
        setLiveLiked(
          owner ? result.posts.filter((post) => !post.demo && post.likes?.liked).map((post) => post.id) : [],
        )
        setLiveFollowing(owner ? (result.following ?? []) : [])
      })
      .catch((error) => {
        if (active.current && epoch.current === currentEpoch)
          notify(error instanceof Error ? error.message : 'Feed unavailable')
      })
  }, [owner])
  useEffect(() => {
    void refresh()
  }, [refresh])

  function toggleLike(id: string) {
    const post = [...posts, ...archivedPosts].find((item) => item.id === id)
    if (!post || !loaded || scope !== owner) return
    if (post.sample) {
      setSamples((value) => ({ ...value, liked: toggleItem(value.liked, id) }))
      return
    }
    if (!owner) {
      notify('Connect your wallet to like community posts.')
      return
    }
    if (feedOwner !== owner) {
      notify('Your wallet preferences are still loading. Try again shortly.')
      return
    }
    const key = `like:${owner}:${id}`
    const currentEpoch = epoch.current
    if (pending.current.has(key)) return
    pending.current.add(key)
    revision.current++
    const wasLiked = feedOwner === owner && liveLiked.includes(id)
    setLiveLiked((value) => toggleItem(feedOwner === owner ? value : [], id))
    setFeedOwner(owner)
    void api<{ count: number; liked: boolean }>(`/v1/posts/${id}/likes`, {
      method: wasLiked ? 'DELETE' : 'POST',
    })
      .then((result) => {
        if (!active.current || epoch.current !== currentEpoch) return
        setLiveLiked((value) =>
          result.liked ? [...new Set([...value, id])] : value.filter((item) => item !== id),
        )
        setPosts((value) => value.map((item) => (item.id === id ? { ...item, likes: result.count } : item)))
      })
      .catch((error) => {
        if (!active.current || epoch.current !== currentEpoch) return
        setLiveLiked((value) =>
          wasLiked ? [...new Set([...value, id])] : value.filter((item) => item !== id),
        )
        notify(error instanceof Error ? error.message : 'Your like could not be saved.')
      })
      .finally(() => pending.current.delete(key))
  }
  function toggleSave(id: string) {
    if (!loaded || scope !== owner) return
    if (sampleIds.has(id)) setSamples((value) => ({ ...value, saved: toggleItem(value.saved, id) }))
    else setLiveSaved((value) => toggleItem(value, id))
  }
  function toggleFollow(name: string) {
    const post = [...posts, ...archivedPosts].find((item) => item.creator === name)
    if (!post || !loaded || scope !== owner) return
    if (post.sample) {
      setSamples((value) => ({ ...value, following: toggleItem(value.following, name) }))
      return
    }
    if (!owner || !post.creatorWallet) {
      notify('Connect your wallet to follow community creators.')
      return
    }
    if (feedOwner !== owner) {
      notify('Your wallet preferences are still loading. Try again shortly.')
      return
    }
    const target = post.creatorWallet
    const key = `follow:${owner}:${target}`
    const currentEpoch = epoch.current
    if (pending.current.has(key)) return
    pending.current.add(key)
    revision.current++
    const wasFollowing = feedOwner === owner && liveFollowing.includes(target)
    setLiveFollowing((value) => toggleItem(feedOwner === owner ? value : [], target))
    setFeedOwner(owner)
    void api<{ following: boolean }>(`/v1/profiles/${target}/follow`, {
      method: wasFollowing ? 'DELETE' : 'POST',
    })
      .then((result) => {
        if (!active.current || epoch.current !== currentEpoch) return
        setLiveFollowing((value) =>
          result.following ? [...new Set([...value, target])] : value.filter((item) => item !== target),
        )
      })
      .catch((error) => {
        if (!active.current || epoch.current !== currentEpoch) return
        setLiveFollowing((value) =>
          wasFollowing ? [...new Set([...value, target])] : value.filter((item) => item !== target),
        )
        notify(error instanceof Error ? error.message : 'Following could not be saved.')
      })
      .finally(() => pending.current.delete(key))
  }
  const liked = [...samples.liked, ...(feedOwner === owner ? liveLiked : [])]
  const saved = [...samples.saved, ...(scope === owner ? liveSaved : [])]
  const following = [
    ...samples.following,
    ...(feedOwner === owner ? liveFollowing : []).map(
      (address) => posts.find((post) => post.creatorWallet === address)?.creator ?? address,
    ),
  ]
  return (
    <Context.Provider
      value={{
        posts,
        liked,
        saved,
        following,
        toggleLike,
        toggleSave,
        toggleFollow,
        message,
        notify,
        refresh,
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function useApp() {
  const context = useContext(Context)
  if (!context) throw new Error('AppStore missing')
  return context
}
