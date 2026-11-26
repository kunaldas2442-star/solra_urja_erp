import React, { useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { apiClient } from '../../services/apiClient';

interface AuthenticatedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string;
  alt: string;
  fallback?: React.ReactNode;
}

export const AuthenticatedImage: React.FC<AuthenticatedImageProps> = ({
  src,
  alt,
  className = '',
  fallback,
  ...rest
}) => {
  const resolvedSrc = apiClient.resolveMediaUrl(src || '');
  const isProtectedUpload = Boolean(
    resolvedSrc &&
    (resolvedSrc.includes('/api/uploads/') || resolvedSrc.startsWith('/uploads/'))
  );

  const [displayUrl, setDisplayUrl] = useState<string>(resolvedSrc);
  const [isLoadingBlob, setIsLoadingBlob] = useState<boolean>(false);
  const [hasFailed, setHasFailed] = useState<boolean>(false);
  const blobUrlRef = useRef<string | null>(null);
  const attemptedBlobRef = useRef<boolean>(false);

  useEffect(() => {
    attemptedBlobRef.current = false;
    setHasFailed(false);

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    if (!resolvedSrc) {
      setDisplayUrl('');
      return;
    }

    // If an in-memory bearer token is present on a protected upload, preload with auth headers directly
    // so cookie-restricted iframes don't emit noisy 401 image errors first.
    if (isProtectedUpload && apiClient.getToken()) {
      let active = true;
      attemptedBlobRef.current = true;
      setIsLoadingBlob(true);
      apiClient
        .fetchAuthorizedBlobUrl(resolvedSrc)
        .then(({ blobUrl }) => {
          if (!active) {
            if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
            return;
          }
          if (blobUrl.startsWith('blob:')) blobUrlRef.current = blobUrl;
          setDisplayUrl(blobUrl);
          setHasFailed(false);
        })
        .catch(() => {
          if (active) {
            setHasFailed(true);
            setDisplayUrl('');
          }
        })
        .finally(() => {
          if (active) setIsLoadingBlob(false);
        });
      return () => {
        active = false;
      };
    }

    setDisplayUrl(resolvedSrc);
  }, [resolvedSrc, isProtectedUpload]);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const handleImageError = async () => {
    if (isProtectedUpload && !attemptedBlobRef.current) {
      attemptedBlobRef.current = true;
      setIsLoadingBlob(true);
      try {
        const { blobUrl } = await apiClient.fetchAuthorizedBlobUrl(resolvedSrc);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        if (blobUrl.startsWith('blob:')) blobUrlRef.current = blobUrl;
        setDisplayUrl(blobUrl);
        setHasFailed(false);
      } catch {
        setHasFailed(true);
      } finally {
        setIsLoadingBlob(false);
      }
      return;
    }
    setHasFailed(true);
  };

  if (isLoadingBlob && !displayUrl) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 text-slate-400 ${className}`}>
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (hasFailed || !displayUrl) {
    if (fallback !== undefined) {
      return <>{fallback}</>;
    }
    return (
      <div className={`flex flex-col items-center justify-center bg-slate-100 text-slate-400 p-2 text-center ${className}`}>
        <ImageOff className="w-5 h-5 mb-1 opacity-60" />
        <span className="text-[10px] font-medium leading-tight">Image unavailable</span>
      </div>
    );
  }

  return (
    <img
      {...rest}
      src={displayUrl}
      alt={alt}
      referrerPolicy="no-referrer"
      className={className}
      onError={handleImageError}
    />
  );
};
