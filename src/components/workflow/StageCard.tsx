import React, { useState, useRef } from 'react';
import { ProjectStage, PhotoAttachment } from '../../types/solar';
import { StatusBadge } from '../common/StatusBadge';
import { AuthenticatedImage } from '../common/AuthenticatedImage';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { getCurrentGPSPosition } from '../../services/gps';
import { apiClient } from '../../services/apiClient';
import { storageService } from '../../services/storage';
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Calendar,
  User,
  Camera,
  FileText,
  MessageSquare,
  Send,
  Lock,
  CheckSquare,
  Square,
  MapPin,
  ThumbsUp,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Loader2,
  AlertCircle,
  ZoomIn,
  X
} from 'lucide-react';

interface StageCardProps {
  projectId: string;
  stage: ProjectStage;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onUpdateStage: (stageKey: string, updates: Partial<ProjectStage>) => void;
  onPhotosUpdated?: () => void;
  customerName: string;
  customerPhone: string;
  projectTitle: string;
  isLocked?: boolean;
  previousStageTitle?: string;
  stageIndex?: number;
  isReadOnly?: boolean;
}

export const StageCard: React.FC<StageCardProps> = ({
  projectId,
  stage,
  isExpanded,
  onToggleExpand,
  onUpdateStage,
  onPhotosUpdated,
  customerName,
  customerPhone,
  projectTitle,
  isLocked = false,
  previousStageTitle,
  stageIndex: _stageIndex,
  isReadOnly = false
}) => {
  const { currentUser, canApproveStage, isCustomer } = useAuth();
  const { openWhatsAppModal, showToast } = useApp();
  const [newNote, setNewNote] = useState('');
  const [isCapturingGPS, setIsCapturingGPS] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null);
  const [previewPhoto, setPreviewPhoto] = useState<PhotoAttachment | null>(null);

  const isReadOnlyEffective = Boolean(
    isReadOnly ||
    isCustomer ||
    (currentUser?.role as string) === 'Customer' ||
    (currentUser as any)?.accountType === 'CUSTOMER'
  );

  const completedChecklistCount = stage.checklist.filter(item => item.completed).length;
  const isAllChecklistDone = stage.checklist.length > 0 && completedChecklistCount === stage.checklist.length;

  const handleToggleChecklist = (itemId: string) => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot modify stage checklist items.', 'info');
      return;
    }

    if (isLocked) {
      showToast(`Stage "${stage.title}" is locked. Complete Stage ${stage.order - 1}${previousStageTitle ? ` (${previousStageTitle})` : ''} first.`, 'warning');
      return;
    }

    const updatedChecklist = stage.checklist.map(item => {
      if (item.id === itemId) {
        const nextState = !item.completed;
        return {
          ...item,
          completed: nextState,
          completedBy: nextState ? currentUser.name : undefined,
          completedAt: nextState ? new Date().toISOString() : undefined
        };
      }
      return item;
    });

    onUpdateStage(stage.stageKey, { checklist: updatedChecklist });
    showToast(`Checklist item updated`, 'info');
  };

  const photoInputRef = useRef<HTMLInputElement>(null);

  const handleCaptureClick = () => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot upload stage photos.', 'warning');
      return;
    }

    if (isLocked) {
      showToast(`Cannot upload photo: Stage "${stage.title}" is locked until Stage ${stage.order - 1} is completed.`, 'warning');
      return;
    }

    photoInputRef.current?.click();
  };

  const prepareImageForUpload = async (file: File): Promise<{ fileName: string; fileData: string }> => {
    const rawDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read selected image file.'));
      reader.readAsDataURL(file);
    });

    const isCompressible = file.size > 750 * 1024;
    if (!isCompressible) {
      return { fileName: file.name, fileData: rawDataUrl };
    }

    return await new Promise<{ fileName: string; fileData: string }>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1920;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ fileName: file.name, fileData: rawDataUrl });
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressedUrl = canvas.toDataURL('image/jpeg', 0.84);
        const baseName = file.name.replace(/\.[^/.]+$/, '') || 'site-photo';
        resolve({ fileName: `${baseName}.jpg`, fileData: compressedUrl });
      };
      img.onerror = () => resolve({ fileName: file.name, fileData: rawDataUrl });
      img.src = rawDataUrl;
    });
  };

  const handleRealPhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPhotoUploadError(null);

    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!allowedMimes.includes(file.type.toLowerCase()) && !['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      const msg = 'Unsupported image format. Please select a JPG, JPEG, PNG, or WebP file.';
      setPhotoUploadError(msg);
      showToast(msg, 'warning');
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      const msg = 'Selected image is too large (max 20 MB before optimization).';
      setPhotoUploadError(msg);
      showToast(msg, 'warning');
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }

    try {
      setIsCapturingGPS(true);
      const gps = await Promise.race([
        getCurrentGPSPosition(),
        new Promise<{ latitude: number; longitude: number; locationName: string }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                latitude: 22.9868,
                longitude: 72.3789,
                locationName: 'GPS Fix Timed Out (Site Coordinate Recorded)'
              }),
            2500
          )
        )
      ]);
      setIsCapturingGPS(false);
      setIsUploadingPhoto(true);

      const prepared = await prepareImageForUpload(file);
      const gpsCoordinates = `${gps.latitude}, ${gps.longitude} (${gps.locationName})`;
      const caption = `${file.name.replace(/\.[^/.]+$/, '')} (${stage.title})`;

      const res = await apiClient.uploadStagePhoto(projectId, stage.stageKey, {
        fileName: prepared.fileName,
        fileData: prepared.fileData,
        caption,
        gpsCoordinates
      });

      storageService.applyStagePhotosUpdate(projectId, stage.stageKey, res.photos);
      onPhotosUpdated?.();
      showToast(`Site photo uploaded & saved to server (${gps.latitude}°, ${gps.longitude}°)`, 'success');
    } catch (err: any) {
      const msg = err?.message || 'Failed to upload site photo to server.';
      setPhotoUploadError(msg);
      showToast(msg, 'error');
    } finally {
      setIsCapturingGPS(false);
      setIsUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  const handleDeletePhoto = async (photoId: string) => {
    if (isReadOnlyEffective || isLocked || deletingPhotoId) return;
    setPhotoUploadError(null);
    setDeletingPhotoId(photoId);
    try {
      const res = await apiClient.deleteStagePhoto(projectId, stage.stageKey, photoId);
      storageService.applyStagePhotosUpdate(projectId, stage.stageKey, res.photos);
      onPhotosUpdated?.();
      showToast('Stage photo removed from server and database', 'info');
    } catch (err: any) {
      const msg = err?.message || 'Failed to remove stage photo.';
      setPhotoUploadError(msg);
      showToast(msg, 'error');
    } finally {
      setDeletingPhotoId(null);
    }
  };

  const handleAddNote = () => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot add operational notes.', 'warning');
      return;
    }

    if (isLocked) {
      showToast(`Cannot add note: Stage "${stage.title}" is locked.`, 'warning');
      return;
    }
    if (!newNote.trim()) return;
    const noteEntry = `${currentUser.name} (${new Date().toLocaleDateString('en-GB')}, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}): ${newNote.trim()}`;
    const updatedNotes = stage.notes ? `${stage.notes}\n\n${noteEntry}` : noteEntry;
    onUpdateStage(stage.stageKey, { notes: updatedNotes });
    setNewNote('');
    showToast('Field notes appended to stage record', 'success');
  };

  const handleMarkCompleted = () => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot complete stages.', 'warning');
      return;
    }

    if (isLocked) {
      showToast(`Cannot complete stage: Stage "${stage.title}" is locked until Stage ${stage.order - 1} is finished.`, 'warning');
      return;
    }

    if (stage.checklist.length > 0 && completedChecklistCount < stage.checklist.length) {
      showToast(`Validation Required: Please complete all ${stage.checklist.length} checklist items before completing this stage. (${completedChecklistCount}/${stage.checklist.length} checked)`, 'warning');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    onUpdateStage(stage.stageKey, {
      status: 'COMPLETED',
      actualEndDate: today,
      completedDate: today
    });
    showToast(`Stage "${stage.title}" marked as COMPLETED! Next stage unlocked.`, 'success');
  };

  const handleRequestApproval = () => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot submit stages for approval.', 'warning');
      return;
    }

    if (isLocked) {
      showToast(`Cannot submit for review: Stage "${stage.title}" is locked.`, 'warning');
      return;
    }

    if (stage.checklist.length > 0 && completedChecklistCount < stage.checklist.length) {
      showToast(`Validation Required: Complete all ${stage.checklist.length} checklist items before submitting for PM approval. (${completedChecklistCount}/${stage.checklist.length} checked)`, 'warning');
      return;
    }

    onUpdateStage(stage.stageKey, {
      status: 'UNDER REVIEW'
    });
    showToast(`Approval requested for "${stage.title}". Notified Project Manager.`, 'info');
  };

  const handleApproveStage = () => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot approve stages.', 'warning');
      return;
    }

    if (isLocked) {
      showToast(`Cannot approve stage: Stage "${stage.title}" is locked until Stage ${stage.order - 1} is finished.`, 'warning');
      return;
    }

    if (stage.checklist.length > 0 && completedChecklistCount < stage.checklist.length) {
      showToast(`Validation Required: All ${stage.checklist.length} checklist items must be verified before approving this stage. (${completedChecklistCount}/${stage.checklist.length} checked)`, 'warning');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    onUpdateStage(stage.stageKey, {
      status: 'COMPLETED',
      approvedBy: currentUser.name,
      approvedAt: today,
      approvalDate: today,
      actualEndDate: today,
      completedDate: today,
      approvalRemarks: `Approved by ${currentUser.role} ${currentUser.name}. Ready for subsequent execution phase.`
    });
    showToast(`Stage "${stage.title}" approved by ${currentUser.name}! Next stage unlocked.`, 'success');
  };

  const handleReopenStage = () => {
    if (isReadOnlyEffective) {
      showToast('Read-only view: Customers cannot reopen stages.', 'warning');
      return;
    }

    onUpdateStage(stage.stageKey, {
      status: 'IN PROGRESS'
    });
    showToast(`Stage "${stage.title}" reopened for modifications. Subsequent stages reset to locked.`, 'warning');
  };

  return (
    <div className={`rounded-2xl border transition-all duration-200 overflow-hidden ${
      isLocked
        ? 'border-slate-200 bg-slate-50/50 opacity-90'
        : stage.status === 'COMPLETED'
        ? 'border-emerald-200 bg-white'
        : stage.status === 'IN PROGRESS'
        ? 'border-amber-400 bg-white shadow-sm ring-1 ring-amber-400/30'
        : 'border-slate-200 bg-white'
    }`}>
      {/* Accordion Header Bar */}
      <div
        onClick={onToggleExpand}
        className="p-4 sm:p-5 flex items-center justify-between cursor-pointer hover:bg-slate-50/70 select-none transition-colors"
      >
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          {/* Order Badge */}
          <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl font-bold flex items-center justify-center text-xs shrink-0 transition-transform ${
            isLocked
              ? 'bg-slate-100 text-slate-400 border border-slate-200'
              : stage.status === 'COMPLETED'
              ? 'bg-emerald-600 text-white'
              : stage.status === 'IN PROGRESS'
              ? 'bg-amber-500 text-white'
              : 'bg-slate-100 text-slate-600 border border-slate-200'
          }`}>
            {isLocked ? (
              <Lock className="w-4 h-4 text-slate-400" />
            ) : stage.status === 'COMPLETED' ? (
              <CheckCircle2 className="w-5 h-5" />
            ) : (
              stage.order
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={`text-sm sm:text-base font-bold truncate ${isLocked ? 'text-slate-600' : 'text-slate-900'}`}>
                {stage.title}
              </h3>
              {isLocked ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                  <Lock className="w-3 h-3 text-slate-400" />
                  Locked (Stage {stage.order})
                </span>
              ) : (
                <StatusBadge status={stage.status} size="sm" />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mt-1">
              <span className="flex items-center gap-1 font-medium">
                <User className="w-3.5 h-3.5 text-slate-400" />
                <span>{stage.assignedToName} ({stage.assignedRole})</span>
              </span>

              {stage.plannedEndDate && (
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  <span>Target: {stage.plannedEndDate}</span>
                </span>
              )}

              <span className="text-slate-400 font-medium">
                Checklist: {completedChecklistCount}/{stage.checklist.length}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-2">
          {/* Progress Pill */}
          <div className="hidden md:flex items-center gap-2 bg-slate-100 px-2.5 py-1 rounded-full text-xs font-semibold text-slate-600">
            <div className="w-12 bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full rounded-full ${isLocked ? 'bg-slate-300' : stage.status === 'COMPLETED' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                style={{ width: `${stage.checklist.length ? (completedChecklistCount / stage.checklist.length) * 100 : stage.status === 'COMPLETED' ? 100 : 0}%` }}
              />
            </div>
            <span>{stage.checklist.length ? Math.round((completedChecklistCount / stage.checklist.length) * 100) : stage.status === 'COMPLETED' ? 100 : 0}%</span>
          </div>

          <button className="p-1 rounded-lg hover:bg-slate-200/60 text-slate-400">
            {isExpanded ? <ChevronUp className="w-5 h-5 text-slate-700" /> : <ChevronDown className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Expanded Accordion Body */}
      {isExpanded && (
        <div className="p-4 sm:p-6 border-t border-slate-100 bg-slate-50/40 space-y-6 animate-in fade-in duration-150">
          {isLocked && (
            <div className="p-3.5 bg-amber-50/80 border border-amber-200 rounded-xl flex items-start sm:items-center gap-2.5 text-xs text-amber-900">
              <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5 sm:mt-0" />
              <span>
                <strong>Sequential Workflow Active:</strong> This stage is currently locked. Complete <strong>Stage {stage.order - 1}{previousStageTitle ? ` (${previousStageTitle})` : ''}</strong> first to unlock downstream actions and completion.
              </span>
            </div>
          )}

          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
            {stage.description}
          </p>

          {/* Checklist Section */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <CheckSquare className="w-3.5 h-3.5 text-amber-500" />
                <span>Verification Checklist ({completedChecklistCount}/{stage.checklist.length})</span>
              </h4>
              <span className="text-[11px] text-slate-500">
                {isReadOnlyEffective ? 'Verified milestone checklist (Read-Only)' : 'Click to toggle item completion'}
              </span>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {stage.checklist.map((item, idx) => (
                <div
                  key={`${item.id}-${idx}`}
                  role={isReadOnlyEffective ? undefined : 'checkbox'}
                  aria-checked={item.completed}
                  onClick={() => !isReadOnlyEffective && handleToggleChecklist(item.id)}
                  className={`p-3 flex items-start gap-3 transition-colors ${
                    isReadOnlyEffective ? 'cursor-default' : 'hover:bg-slate-50 cursor-pointer'
                  }`}
                >
                  <button
                    type="button"
                    disabled={isReadOnlyEffective}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnlyEffective) handleToggleChecklist(item.id);
                    }}
                    className={`mt-0.5 shrink-0 ${
                      isReadOnlyEffective ? 'cursor-default' : 'text-slate-400 hover:text-amber-600 focus:outline-hidden'
                    }`}
                    aria-label={`Toggle ${item.label || item.title}`}
                  >
                    {item.completed ? (
                      <CheckSquare className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-300" />
                    )}
                  </button>
                  <div className="flex-1">
                    <span className={`text-xs font-medium ${item.completed ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                      {item.label || item.title}
                    </span>
                    {item.completed && item.completedBy && (
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        Verified by {item.completedBy}
                        {item.completedAt && !isNaN(new Date(item.completedAt).getTime()) && (
                          <> at {new Date(item.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Photo & GPS Geo-Tagged Field Evidence */}
          <div>
            <div className="flex items-center justify-between mb-2.5 gap-2 flex-wrap">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5 text-blue-500" />
                <span>Site Photos & GPS Coordinate Verification ({stage.photos.length})</span>
              </h4>
              {!isReadOnlyEffective ? (
                <>
                  <input
                    type="file"
                    ref={photoInputRef}
                    accept="image/jpeg,image/jpg,image/png,image/webp"
                    className="hidden"
                    onChange={handleRealPhotoUpload}
                  />
                  <button
                    type="button"
                    onClick={handleCaptureClick}
                    disabled={isCapturingGPS || isUploadingPhoto || isLocked}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed text-slate-700 rounded-xl text-xs font-bold shadow-2xs transition-colors cursor-pointer"
                  >
                    {isCapturingGPS || isUploadingPhoto ? (
                      <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                    ) : (
                      <Camera className="w-3.5 h-3.5 text-amber-500" />
                    )}
                    <span>
                      {isCapturingGPS
                        ? 'Locating GPS...'
                        : isUploadingPhoto
                        ? 'Uploading Photo...'
                        : 'Upload / Capture Photo'}
                    </span>
                  </button>
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                  <Camera className="w-3.5 h-3.5 text-blue-500" />
                  <span>Field Evidence Gallery ({stage.photos.length})</span>
                </span>
              )}
            </div>

            {photoUploadError && (
              <div className="mb-3 flex items-center justify-between gap-2 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 font-medium">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{photoUploadError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPhotoUploadError(null)}
                  className="text-rose-500 hover:text-rose-700 p-0.5 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {stage.photos.length === 0 ? (
              <div className="p-6 bg-white rounded-xl border border-dashed border-slate-200 text-center text-xs text-slate-400">
                {isReadOnlyEffective
                  ? 'No site photos uploaded for this stage yet by project engineers.'
                  : 'No site photos uploaded for this stage yet. Click "Upload / Capture Photo" to store image evidence with live GPS metadata.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {stage.photos.map(p => (
                  <div key={p.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xs group">
                    <div
                      onClick={() => setPreviewPhoto(p)}
                      className="relative h-32 w-full overflow-hidden bg-slate-100 cursor-pointer"
                    >
                      <AuthenticatedImage
                        src={p.url}
                        alt={p.caption}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="p-1 rounded-md bg-black/65 text-white" title="Preview full image">
                          <ZoomIn className="w-3.5 h-3.5" />
                        </span>
                        {!isReadOnlyEffective && !isLocked && (
                          <button
                            type="button"
                            disabled={deletingPhotoId === p.id}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              handleDeletePhoto(p.id);
                            }}
                            title="Delete photo"
                            className="p-1 rounded-md bg-rose-600/90 hover:bg-rose-700 text-white cursor-pointer disabled:opacity-50"
                          >
                            {deletingPhotoId === p.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                      <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[9px] px-1.5 py-0.5 rounded-sm font-mono flex items-center gap-1">
                        <MapPin className="w-2.5 h-2.5 text-amber-400" />
                        <span className="truncate max-w-[120px]">{p.gpsCoordinates || 'GPS Tagged'}</span>
                      </div>
                    </div>
                    <div className="p-2.5">
                      <p className="text-xs font-bold text-slate-800 truncate">{p.caption}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5 flex items-center justify-between">
                        <span>By {p.uploadedBy}</span>
                        <span>{new Date(p.uploadedAt).toLocaleDateString()}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {previewPhoto && (
            <div
              onClick={() => setPreviewPhoto(null)}
              className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl border border-slate-200"
              >
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold text-slate-900 truncate">{previewPhoto.caption}</h4>
                    <p className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                      <span>Uploaded by {previewPhoto.uploadedBy}</span>
                      {previewPhoto.gpsCoordinates && (
                        <>
                          <span>•</span>
                          <span className="font-mono text-amber-700">{previewPhoto.gpsCoordinates}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewPhoto(null)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200/60 cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="p-4 bg-slate-950 flex-1 overflow-auto flex items-center justify-center">
                  <AuthenticatedImage
                    src={previewPhoto.url}
                    alt={previewPhoto.caption}
                    className="max-h-[70vh] w-auto object-contain rounded-lg"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Stage Approval & Sign-off Details */}
          {(stage.approvedBy || stage.status === 'UNDER REVIEW') && (
            <div className="p-4 bg-amber-50/70 border border-amber-200 rounded-xl space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                <ThumbsUp className="w-4 h-4 text-amber-600" />
                <span>Stage Approval Log</span>
              </div>
              {stage.approvedBy ? (
                <p className="text-xs text-amber-800">
                  Formally approved by <span className="font-bold">{stage.approvedBy}</span> on {stage.approvedAt}.
                  <br />
                  <span className="italic text-[11px] text-amber-700">{stage.approvalRemarks}</span>
                </p>
              ) : (
                <p className="text-xs text-amber-800">
                  Submission awaiting Admin formal sign-off.
                </p>
              )}
            </div>
          )}

          {/* Stage Notes / Work Log */}
          <div>
            <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-slate-500" />
              <span>Field Engineering Notes & Log</span>
            </h4>

            {stage.notes ? (
              <div className="p-3.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed mb-3">
                {stage.notes}
              </div>
            ) : isReadOnlyEffective ? (
              <div className="p-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-400 italic mb-1">
                No operational engineering notes recorded for this stage yet.
              </div>
            ) : null}

            {!isReadOnlyEffective && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddNote(); }}
                  placeholder="Type operational field notes or inspection remark..."
                  className="flex-1 text-xs border border-slate-200 rounded-xl px-3 py-2 bg-white focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                />
                <button
                  onClick={handleAddNote}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition-colors shrink-0"
                >
                  Add Note
                </button>
              </div>
            )}
          </div>

          {/* Operational Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200">
            {isReadOnlyEffective ? (
              <>
                <div className="flex items-center gap-2">
                  <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 select-none">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Read-Only Stage View (Maintained by Solar Urja Engineering Team)</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={stage.status} size="sm" />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {/* WhatsApp Milestone Update */}
                  <button
                    onClick={() =>
                      openWhatsAppModal(customerPhone, customerName, 'INSTALLATION_UPDATE', {
                        projectTitle,
                        stageTitle: stage.title
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-xl text-xs font-bold transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />
                    <span>WhatsApp Client Update</span>
                  </button>

                  {stage.status === 'COMPLETED' && (
                    <button
                      onClick={handleReopenStage}
                      className="inline-flex items-center gap-1 px-3 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl text-xs font-medium transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reopen Stage</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {isLocked ? (
                    <div className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs text-slate-500 font-medium select-none">
                      <Lock className="w-3.5 h-3.5 text-slate-400" />
                      <span>Locked: Finish Stage {stage.order - 1} first</span>
                    </div>
                  ) : stage.status !== 'COMPLETED' ? (
                    <>
                      {canApproveStage() ? (
                        <button
                          onClick={handleApproveStage}
                          className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-colors shadow-2xs"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Approve & Complete Stage</span>
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={handleRequestApproval}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-bold transition-colors shadow-2xs"
                          >
                            <Send className="w-3.5 h-3.5" />
                            <span>Submit for PM Approval</span>
                          </button>

                          <button
                            onClick={handleMarkCompleted}
                            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold shadow-2xs"
                          >
                            <span>Direct Complete</span>
                          </button>
                        </>
                      )}
                    </>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
