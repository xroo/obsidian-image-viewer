import { App, Plugin, TFile } from 'obsidian';
import { ItemView, WorkspaceLeaf } from 'obsidian';

export default class ImageViewer extends Plugin {

	async onload() {

		this.registerView(VIEW_TYPE_IMAGE, leaf => new ImageView(leaf));

		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile) => {
				if (file && ImageViewer.isImageFile(file)) {
					this.openInViewer(file);
				}
			})
		);

		// This adds a settings tab so the user can configure various aspects of the plugin
	}

	onunload() {}


	static isImageFile(file: TFile): boolean {
		const imageExtensions = new Set([
			'png', 'jpg', 'jpeg', 'gif',
			'bmp', 'svg', 'webp', 'avif', 
			'tiff', 'ico', 'heic'
		]);
		return imageExtensions.has(file.extension.toLowerCase());
	}

	async openInViewer(imageFile: TFile): Promise<void> {
		// Ищем существующую вкладку с галереей
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_IMAGE)[0];

		if (!leaf) {
			leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({type: VIEW_TYPE_IMAGE, active: true});
		}

		// Preventing the opening of native imave viewer by closing it
		this.app.workspace.getLeavesOfType('image')
			.filter(leaf => leaf.view.getState()?.file === imageFile.path)
			.forEach(leaf => leaf.detach());

		const view = leaf.view as ImageView;
		await view.loadImage(imageFile);

		this.app.workspace.revealLeaf(leaf);
	}
}

export const VIEW_TYPE_IMAGE = 'image-viewer';

export class ImageView extends ItemView {
	currentImage: TFile | null = null;
	mainImageEl: HTMLImageElement;
	thumbnailStrip: HTMLElement;
	imageList: TFile[] = []; // Список изображений в текущей папке
	currentIndex: number = -1; // Индекс текущего изображения

	// Image Zoom and Drag Fields
	private zoomLevel: number = 1.0;
	private maxZoom: number = 5.0;
	private minZoom: number = 0.2;
	private zoomStep: number = 0.1;
	private isDragging: boolean = false;
	private dragStartX: number = 0;
	private dragStartY: number = 0;
	private translateX: number = 0;
	private translateY: number = 0;

	getViewType()                    { return VIEW_TYPE_IMAGE; }
	getDisplayText(): string         { return 'Image Viewer'; }
	getIcon(): string                { return 'images'; }
	constructor(leaf: WorkspaceLeaf) { super(leaf); }

	async onOpen() {
		const container = this.contentEl;
		container.empty();

		const wrapper = container.createEl('div', { cls: 'image-gallery-container' });
		const displayArea = wrapper.createEl('div', { cls: 'image-display-area' });

		this.mainImageEl = displayArea.createEl('img', { 
			cls: 'main-image',
			attr: { src: '' }
		});

		this.thumbnailStrip = wrapper.createEl('div', { cls: 'thumbnail-strip' });

		this.setupEventListeners();

		if (this.currentImage) {
			await this.loadImage(this.currentImage);
		}

	}

	private setupEventListeners(): void {
		// Zoom and drag
		this.mainImageEl.addEventListener('wheel', e => this.handleZoom(e), { passive: false });
		this.mainImageEl.addEventListener('mousedown', e => this.startDrag(e));
		this.mainImageEl.addEventListener('dblclick', () => this.resetZoom());

		this.mainImageEl.addEventListener('dragstart', (e) => e.preventDefault());

		document.addEventListener('mousemove', e => this.doDrag(e));
		document.addEventListener('mouseup', () => this.stopDrag());

		// Горизонтальный скролл миниатюр
		this.thumbnailStrip.addEventListener('wheel', (e) => {
			if (e.deltaY !== 0) {
				this.thumbnailStrip.scrollLeft += e.deltaY;
				e.preventDefault();
			}
		}, { passive: false });

		// Keyboard navigation
		this.registerDomEvent(document, 'keydown', (event: KeyboardEvent) => {
			if (!this.containerEl.isShown()) return;

			switch(event.key) {
				case 'ArrowLeft':
					event.preventDefault();
					this.navigateImage(-1);
					break;
				case 'ArrowRight':
					event.preventDefault();
					this.navigateImage(1);
					break;
			}
		});
	}

	async loadImage(imageFile: TFile): Promise<void> {
		this.currentImage = imageFile;
		this.setTabTitle(imageFile.basename);
		this.mainImageEl.src = this.app.vault.getResourcePath(imageFile);
		this.mainImageEl.alt = imageFile.name;

		await this.updateImageList(imageFile);
		await this.updateThumbnails();
		this.resetZoom();
	}

	private setTabTitle(title: string): void {
		this.leaf.tabHeaderInnerTitleEl.setText(title);
	}

	// Получаем все изображения в папке текущего файла
	async updateImageList(currentFile: TFile): Promise<void> {
		if (!currentFile?.parent) return;

		this.imageList = this.app.vault.getFiles()
			.filter(file => 
				file.parent?.path === currentFile.parent.path && 
				ImageViewer.isImageFile(file)
			).sort((a, b) => a.name.localeCompare(b.name));

		this.currentIndex = this.imageList.findIndex(file => file.path === currentFile.path);
	}

	private async navigateImage(direction: -1 | 1): Promise<void> {
		if (this.imageList.length === 0) return;

		const newIndex = this.currentIndex + direction;
		if (newIndex >= 0 && newIndex < this.imageList.length) {
			await this.loadImage(this.imageList[newIndex]);
		}
	}

	async showPrevImage(): Promise<void> {
		await this.navigateImage(-1);
	}

	async showNextImage(): Promise<void> {
		await this.navigateImage(1);
	}

	// Создание миниатюр (базовая версия)
	async updateThumbnails(): Promise<void> {
		if (!this.thumbnailStrip) return;

		this.thumbnailStrip.empty();

		this.imageList.forEach((imgFile, index) => {
			const isActive = index === this.currentIndex;
			const thumbWrapper = this.thumbnailStrip.createEl('div', {
				cls: `thumbnail-wrapper ${isActive ? 'active' : ''}`,
				attr: { 'data-index': index.toString() }
			});

			const thumb = thumbWrapper.createEl('img', {
				cls: 'thumbnail',
				attr: {
					src: this.app.vault.getResourcePath(imgFile),
					alt: imgFile.basename
				}
			});

			// Обработчик клика на миниатюру
			if (index !== this.currentIndex) {
				thumb.addEventListener('click', () => this.loadImage(imgFile));
			}
		});
		this.scrollToActiveThumbnail();
	}

	private scrollToActiveThumbnail(): void {
		if (this.currentIndex < 0) return;
		
		const activeThumb = this.thumbnailStrip.querySelector(`.thumbnail-wrapper[data-index="${this.currentIndex}"]`);
		if (activeThumb) {
			activeThumb.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: 'center'
			});
		}
	}

	// Обработка колесика мыши
	handleZoom(event: WheelEvent): void {
		event.preventDefault();

		// Ctrl/Cmd + колесико = зум, иначе - навигация
		if (event.ctrlKey || event.metaKey) {
			// Зум
			const delta = Math.sign(event.deltaY) > 0 ? -1 : 1;
			this.zoomLevel = Math.max(
				this.minZoom,
				Math.min(this.maxZoom, this.zoomLevel + delta * this.zoomStep)
			);

			this.applyZoom();

		} else {
			this.navigateImage(event.deltaY > 0 ? 1 : -1);
		}
	}

	// Применение зума к изображению
	private applyZoom(): void {
		if (!this.mainImageEl) return;

		const transform = `scale(${this.zoomLevel}) translate(${this.translateX}px, ${this.translateY}px)`;
		this.mainImageEl.style.transform = transform;
		this.mainImageEl.style.transformOrigin = 'center center';
	    // Показываем курсор "рука" при зуме > 100%
		this.mainImageEl.style.cursor = this.zoomLevel > 1.0 ? 'grab' : 'zoom-in';

		if (this.zoomLevel === 1.0) {
			this.translateX = this.translateY = 0;
		}
	}

	// Сброс зума (например, по двойному клику)
	resetZoom(): void {
		this.zoomLevel = 1.0;
		this.translateX = this.translateY = 0;
		this.applyZoom();
	}

	// Методы для перетаскивания зуммированного изображения
	private startDrag(event: MouseEvent): void {
		if (this.zoomLevel <= 1.0) return;

		this.isDragging = true;
		this.dragStartX = event.clientX - this.translateX * this.zoomLevel;
		this.dragStartY = event.clientY - this.translateY * this.zoomLevel;
		this.mainImageEl.style.cursor = 'grabbing';
	}
	private doDrag(event: MouseEvent): void {
		if (!this.isDragging || this.zoomLevel <= 1.0) return;

		this.translateX = (event.clientX - this.dragStartX) / this.zoomLevel;
		this.translateY = (event.clientY - this.dragStartY) / this.zoomLevel;
		this.applyZoom();
	}
	private stopDrag(): void {
		this.isDragging = false;
		if (this.mainImageEl && this.zoomLevel > 1.0) {
			this.mainImageEl.style.cursor = 'grab';
		}
	}

	async onClose() {}
}