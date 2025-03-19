import { View, WorkspaceLeaf, moment, TFile, App, debounce, Notice } from 'obsidian';
import type TaskPlannerPlugin from '../main';
import { TaskManager } from './TaskManager';
import { TimeBlockManager } from './TimeBlockManager';
import { TaskDragManager } from './TaskDragManager';
import { TimeBlockModal, setupSplitter } from './TimelineComponents';
import { zoom } from './TimelineUtils';
import type { ITimelineView } from './TimelineInterfaces';

export class TimelineView extends View implements ITimelineView {
    private plugin: TaskPlannerPlugin;
    private timelineEl: HTMLElement;
    private timeSlots: Map<number, HTMLElement> = new Map();
    private currentDayFile: TFile | null = null;
    private isCreatingTimeBlock: boolean = false;
    private timeBlockStart: number | null = null;
    private modifiedFiles: Set<string> = new Set();
    private hourHeight: number = 80;
    private minHourHeight: number = 40;
    private maxHourHeight: number = 200;
    private taskManager: TaskManager;
    private timeBlockManager: TimeBlockManager;
    private taskDragManager: TaskDragManager;
    private debouncedRefresh: () => void;
    private currentDate: moment.Moment;
    private headerTitleEl: HTMLElement;
    private currentTimeIndicator: HTMLElement | null = null;
    private timeIndicatorInterval: number | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: TaskPlannerPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.taskManager = new TaskManager(this.app, this);
        this.timeBlockManager = new TimeBlockManager(this.app, this, this.hourHeight);
        this.taskDragManager = new TaskDragManager(this.app, this);
        this.debouncedRefresh = debounce(this.refreshView.bind(this), 1000, true);
        this.currentDate = moment(); // Initialize with today's date
    }

    getViewType(): string {
        return 'timeline-view';
    }

    getDisplayText(): string {
        return 'Task Timeline';
    }

    getPlugin(): TaskPlannerPlugin {
        return this.plugin;
    }

    getTimelineEl(): HTMLElement {
        return this.timelineEl;
    }

    getCurrentDayFile(): TFile | null {
        return this.currentDayFile;
    }

    getTaskManager(): TaskManager {
        return this.taskManager;
    }

    getTimeBlockManager(): TimeBlockManager {
        return this.timeBlockManager;
    }

    getTaskDragManager(): TaskDragManager {
        return this.taskDragManager;
    }

    getCurrentDate(): moment.Moment {
        return this.currentDate;
    }

    async onOpen() {
        const { containerEl } = this;
        containerEl.empty();
        
        // Create main container
        const mainContainer = containerEl.createEl('div', { cls: 'timeline-main-container' });
        
        // Create header
        const headerEl = mainContainer.createEl('div', { cls: 'timeline-header' });
        this.headerTitleEl = headerEl.createEl('h4', { text: `Timeline for ${this.currentDate.format('MMMM D, YYYY')}` });
        
        // Create controls
        const controlsEl = headerEl.createEl('div', { cls: 'timeline-controls' });
        
        // Add date navigation buttons
        const dateNavEl = controlsEl.createEl('div', { cls: 'timeline-date-nav' });
        
        const prevBtn = dateNavEl.createEl('button', { text: '◀ Previous' });
        prevBtn.setAttribute('title', 'Previous Day');
        prevBtn.addEventListener('click', async () => {
            this.currentDate = moment(this.currentDate).subtract(1, 'day');
            this.updateHeaderTitle();
            this.taskManager.clearCaches();
            await this.refreshView();
        });
        
        const todayBtn = dateNavEl.createEl('button', { text: 'Today' });
        todayBtn.setAttribute('title', 'Go to Today');
        todayBtn.addEventListener('click', async () => {
            this.currentDate = moment();
            this.updateHeaderTitle();
            this.taskManager.clearCaches();
            await this.refreshView();
        });
        
        const nextBtn = dateNavEl.createEl('button', { text: 'Next ▶' });
        nextBtn.setAttribute('title', 'Next Day');
        nextBtn.addEventListener('click', async () => {
            this.currentDate = moment(this.currentDate).add(1, 'day');
            this.updateHeaderTitle();
            this.taskManager.clearCaches();
            await this.refreshView();
        });
        
        // Add refresh button
        const refreshBtn = controlsEl.createEl('button', { text: '🔄' });
        refreshBtn.setAttribute('title', 'Refresh Timeline');
        refreshBtn.addEventListener('click', async () => {
            this.taskManager.clearCaches();
            await this.refreshView();
        });

        // Create timeline container
        this.timelineEl = mainContainer.createEl('div', { cls: 'timeline-container' });
        
        // Create splitter
        const splitter = mainContainer.createEl('div', { cls: 'timeline-splitter' });
        
        // Create unscheduled tasks area
        const unscheduledArea = mainContainer.createEl('div', { cls: 'unscheduled-tasks' });
        unscheduledArea.createEl('h6', { text: 'Unscheduled Tasks' });
        const dropZone = unscheduledArea.createEl('div', { 
            cls: 'unscheduled-drop-zone',
            attr: { 'data-time': 'unscheduled' }
        });
        this.setupDropZone(dropZone);

        // Setup splitter drag functionality
        setupSplitter(splitter, this.timelineEl, unscheduledArea);

        // Register file change handler
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    // Mark file as modified for markdown files
                    this.modifiedFiles.add(file.path);
                    
                    // Schedule a debounced refresh to pick up any new tasks
                    this.debouncedRefresh();
                }
            })
        );

        // Initial load
        await this.refreshView();
    }

    private initializeTimeIndicator() {
        // Clear any existing interval first
        if (this.timeIndicatorInterval) {
            window.clearInterval(this.timeIndicatorInterval);
        }

        // Create the time indicator element if it doesn't exist
        if (!this.currentTimeIndicator) {
            this.currentTimeIndicator = this.timelineEl.createEl('div', { cls: 'current-time-indicator' });
        }

        // Update the indicator position immediately
        this.updateTimeIndicator();

        // Set up the interval to update the indicator
        this.timeIndicatorInterval = window.setInterval(() => {
            this.updateTimeIndicator();
        }, 60000); // Update every minute
    }

    private updateTimeIndicator() {
        if (!this.currentTimeIndicator || !this.currentDate) return;

        const now = moment();
        const isToday = now.isSame(this.currentDate, 'day');

        // Only show the indicator if we're viewing today
        this.currentTimeIndicator.style.display = isToday ? 'block' : 'none';

        if (isToday) {
            const currentHour = now.hours() + now.minutes() / 60;
            const top = currentHour * this.hourHeight;
            this.currentTimeIndicator.style.top = `${top}px`;
        }
    }

    private createTimeSlots() {
        for (let hour = 0; hour < 24; hour++) {
            const timeSlot = this.timelineEl.createEl('div', { cls: 'time-slot' });
            timeSlot.style.height = `${this.hourHeight}px`;
            
            const timeLabel = timeSlot.createEl('div', { 
                cls: 'time-label',
                text: `${hour.toString().padStart(2, '0')}:00`
            });
            
            const hourMarker = timeSlot.createEl('div', {
                cls: 'hour-marker',
                attr: { 'data-time': `${hour}` }
            });
            
            const halfHourMarker = timeSlot.createEl('div', {
                cls: 'half-hour-marker',
                attr: { 'data-time': `${hour + 0.5}` }
            });

            // Create a container for drop zones
            const dropZoneContainer = timeSlot.createEl('div', { cls: 'time-drop-zone-container' });

            // Create drop zones for all quarters including the hour mark
            for (let quarter = 0; quarter < 4; quarter++) {
                const dropZone = dropZoneContainer.createEl('div', { 
                    cls: 'time-drop-zone',
                    attr: { 'data-time': `${hour + quarter * 0.25}` }
                });

                // Add time block creation handlers
                dropZone.addEventListener('mousedown', (e) => {
                    this.isCreatingTimeBlock = true;
                    this.timeBlockStart = hour + quarter * 0.25;
                });

                dropZone.addEventListener('mouseover', (e) => {
                    if (this.isCreatingTimeBlock && this.timeBlockStart !== null) {
                        this.showTimeBlockPreview(this.timeBlockStart, hour + quarter * 0.25);
                    }
                });
                
                this.timeSlots.set(hour + quarter * 0.25, dropZone);
            }
        }

        // Add mouseup handler to document
        document.addEventListener('mouseup', async (e) => {
            if (this.isCreatingTimeBlock && this.timeBlockStart !== null) {
                // Check if we clicked inside a modal
                const clickedElement = e.target as HTMLElement;
                if (clickedElement.closest('.modal')) {
                    return;
                }
                
                // Get the current time from the element under the mouse
                const element = document.elementFromPoint(e.clientX, e.clientY);
                const currentTime = element?.closest('.time-drop-zone')?.getAttribute('data-time');
                
                await this.createNewTimeBlock(
                    this.timeBlockStart,
                    currentTime ? parseFloat(currentTime) : this.timeBlockStart
                );
                
                this.isCreatingTimeBlock = false;
                this.timeBlockStart = null;
            }
        });

        // Add scroll zoom handler to timeline container
        this.timelineEl.addEventListener('wheel', (e: WheelEvent) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                // Pass the relative Y position of the mouse in the container
                const rect = this.timelineEl.getBoundingClientRect();
                const mouseY = e.clientY - rect.top;
                this.hourHeight = zoom(
                    this.hourHeight,
                    zoomFactor,
                    mouseY,
                    this.timelineEl,
                    this.timeBlockManager.getTimeBlocks(),
                    this.minHourHeight,
                    this.maxHourHeight
                );
                this.timeBlockManager.updateHourHeight(this.hourHeight);
            }
        });
    }

    private setupDropZone(element: HTMLElement) {
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            element.addClass('drag-over');
        });

        element.addEventListener('dragleave', () => {
            element.removeClass('drag-over');
        });

        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            element.removeClass('drag-over');
            const taskIdentifier = e.dataTransfer?.getData('text/plain');
            if (!taskIdentifier) return;

            await this.taskDragManager.handleTaskDrop(
                taskIdentifier,
                element,
                this.timeBlockManager.getTimeBlocks(),
                undefined,
                true
            );
        });
    }

    private async createNewTimeBlock(startTime: number, endTime: number) {
        // Reset time block creation state before opening modal
        this.isCreatingTimeBlock = false;
        this.timeBlockStart = null;
        
        // If there's no daily note, we can't create time blocks
        if (!this.currentDayFile) {
            new Notice(`Cannot create time blocks: No daily note exists for ${this.currentDate.format('MMMM D, YYYY')}`);
            return;
        }
        
        const modal = new TimeBlockModal(this.app);
        const title = await modal.openAndGetValue();
        if (!title) return;

        const id = `block-${Date.now()}`;
        const timeBlock = {
            id,
            title,
            startTime: Math.min(startTime, endTime),
            endTime: Math.max(startTime, endTime) + 0.25,  // +0.25 because end time is exclusive
            tasks: []
        };

        this.timeBlockManager.getTimeBlocks().set(id, timeBlock);
        this.timeBlockManager.renderTimeBlock(timeBlock, this.timelineEl);
        await this.timeBlockManager.saveTimeBlocks(this.currentDayFile);
    }

    private showTimeBlockPreview(startTime: number, currentTime: number) {
        // Remove any existing preview
        const existingPreview = this.timelineEl.querySelector('.time-block-preview');
        if (existingPreview) {
            existingPreview.remove();
        }

        // Create preview element
        const previewEl = document.createElement('div');
        previewEl.addClass('time-block-preview', 'time-block');
        
        // Calculate position
        const start = Math.min(startTime, currentTime);
        const end = Math.max(startTime, currentTime) + 0.25;
        const top = start * this.hourHeight;
        const height = (end - start) * this.hourHeight;
        
        previewEl.style.top = `${top}px`;
        previewEl.style.height = `${height}px`;
        
        this.timelineEl.appendChild(previewEl);
    }

    private updateHeaderTitle() {
        if (this.headerTitleEl) {
            this.headerTitleEl.setText(`Timeline for ${this.currentDate.format('MMMM D, YYYY')}`);
        }
    }

    private async loadTasks() {
        const currentDateStr = this.currentDate.format('YYYY-MM-DD');
        
        // If this is the initial load, process all files
        if (this.taskManager.getTaskCache().size === 0) {
            const files = this.app.vault.getMarkdownFiles();
            
            for (const file of files) {
                await this.taskManager.processFile(file, currentDateStr);
            }
        } else {
            // For subsequent loads, only process modified files
            const modifiedFiles = Array.from(this.modifiedFiles)
                .map(path => this.app.vault.getAbstractFileByPath(path))
                .filter((file): file is TFile => file instanceof TFile);
                
            for (const file of modifiedFiles) {
                await this.taskManager.processFile(file, currentDateStr);
            }
            
            // Clear the modified files set after processing
            this.modifiedFiles.clear();
        }
    }

    private async loadScheduledTasks() {
        const currentDateStr = this.currentDate.format('YYYY-MM-DD');
        const dailyNotes = this.app.vault.getMarkdownFiles().filter(file => 
            file.basename === currentDateStr
        );

        if (dailyNotes.length > 0) {
            this.currentDayFile = dailyNotes[0];
        } else {
            // If no daily note exists, set currentDayFile to null
            // This will result in an empty timeline
            this.currentDayFile = null;
        }
    }

    public async refreshView() {
        // Store current scroll position
        const scrollPosition = this.timelineEl.scrollTop;

        try {
            // First load scheduled tasks and tasks
            await Promise.all([
                this.loadScheduledTasks(),
                this.loadTasks()
            ]);
            
            // Store the current time indicator element before clearing
            const oldTimeIndicator = this.currentTimeIndicator;
            
            // Clear the timeline
            this.timelineEl.empty();
            
            // Reset the current time indicator reference since we cleared it
            this.currentTimeIndicator = null;
            
            // Recreate time slots
            this.createTimeSlots();
            
            // Update the header title
            this.updateHeaderTitle();
            
            // If there's no daily note, show a message
            if (!this.currentDayFile) {
                const messageEl = this.timelineEl.createEl('div', { 
                    cls: 'timeline-no-daily-note-message',
                    attr: { style: 'text-align: center; padding: 20px; color: var(--text-muted);' }
                });
                messageEl.createEl('p', { text: `No daily note exists for ${this.currentDate.format('MMMM D, YYYY')}.` });
                messageEl.createEl('p', { text: 'Create a daily note to use the timeline.' });
                
                // Find the unscheduled drop zone and clear it
                const unscheduledDropZone = this.containerEl.querySelector('.unscheduled-drop-zone');
                if (unscheduledDropZone) {
                    unscheduledDropZone.empty();
                    
                    // Still show unscheduled tasks even if there's no daily note
                    this.showUnscheduledTasks(unscheduledDropZone);
                }
                
                return;
            }
            
            // Then load time blocks after tasks are loaded
            await this.timeBlockManager.loadTimeBlocks(this.currentDayFile);

            // Find the unscheduled drop zone
            const unscheduledDropZone = this.containerEl.querySelector('.unscheduled-drop-zone');
            if (unscheduledDropZone) {
                unscheduledDropZone.empty();
                this.showUnscheduledTasks(unscheduledDropZone);
            }
            
            // Initialize the time indicator after everything else is set up
            this.initializeTimeIndicator();
            
            // Restore scroll position
            this.timelineEl.scrollTop = scrollPosition;
            
        } catch (error) {
            console.error('Error refreshing timeline view:', error);
        }
    }

    private showUnscheduledTasks(dropZone: Element) {
        // Filter tasks to only show those due on or before the current date
        const currentDateMoment = this.currentDate.clone().endOf('day');
        
        this.taskManager.getTaskElements().forEach((taskEl, identifier) => {
            let isScheduled = false;
            this.timeBlockManager.getTimeBlocks().forEach(block => {
                if (block.tasks.some(taskIdentity => taskIdentity.identifier === identifier)) {
                    isScheduled = true;
                }
            });

            if (!isScheduled) {
                const taskIdentity = this.taskManager.getTaskCache().get(identifier);
                if (taskIdentity) {

                    // Only show tasks that have a due date and are due on or before the current date
                    const shouldShow = taskIdentity.metadata.dueDate && 
                        moment(taskIdentity.metadata.dueDate).isSameOrBefore(currentDateMoment);
                        
                    if (shouldShow) 
                    {
                        const clonedTask = this.taskManager.setupClonedTask(taskEl, taskIdentity);
                        dropZone.appendChild(clonedTask);
                    }
                }
            }
        });
    }

    onunload() {
        // Clear the time indicator interval
        if (this.timeIndicatorInterval) {
            window.clearInterval(this.timeIndicatorInterval);
        }
        this.taskManager.clearCaches();
    }
} 